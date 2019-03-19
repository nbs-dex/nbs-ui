import React from "react";
import Translate from "react-translate-component";
import {ChainStore} from "bitsharesjs";
import AmountSelector from "../Utility/AmountSelector";

import AccountStore from "stores/AccountStore";
import AccountSelector from "../Account/AccountSelector";
import TransactionConfirmStore from "stores/TransactionConfirmStore";
import {Asset} from "common/MarketClasses";
import {debounce, isNaN} from "lodash-es";
import {
    checkFeeStatusAsync,
    checkBalance,
    shouldPayFeeWithAssetAsync
} from "common/trxHelper";
import BalanceComponent from "../Utility/BalanceComponent";
import utils from "common/utils";
import counterpart from "counterpart";
import {connect} from "alt-react";
import {Modal, Button} from "bitshares-ui-style-guide";

class DirectDebitClaimModal extends React.Component {
    constructor(props) {
        super(props);
        this.state = this.getInitialState(props);
        this.onTrxIncluded = this.onTrxIncluded.bind(this);
        this._updateFee = debounce(this._updateFee.bind(this), 250);
        this._checkFeeStatus = this._checkFeeStatus.bind(this);
        this._checkBalance = this._checkBalance.bind(this);
        this._isMounted = false;
    }

    getInitialState() {
        return {
            to_name: "",
            from_account: null,
            to_account: null,
            orig_account: null,
            amount: "",
            asset_id: null,
            asset: null,
            memo: "",
            error: null,
            knownScammer: null,
            propose: false,
            propose_account: "",
            feeAsset: null,
            fee_asset_id: "1.3.0",
            feeAmount: new Asset({amount: 0}),
            feeStatus: {},
            maxAmount: false,
            num_of_periods: "",
            period: {amount: "", type: {seconds: 604800, name: "Week"}},
            period_start_time: null,
            permissionId: "",
            balanceError: false
        };
    }

    onSubmit = e => {
        e.preventDefault();
    };

    componentDidUpdate(prevProps, prevState) {
        const {operation} = this.props;
        if (
            this.props.isModalVisible &&
            prevProps.isModalVisible !== this.props.isModalVisible
        ) {
            this.setState(
                {
                    from_account: ChainStore.getAccount(
                        this.props.currentAccount
                    )
                },
                () => {
                    this._updateFee();
                    this._checkFeeStatus(this.state);
                }
            );
        } else if (
            !this.props.isModalVisible &&
            prevProps.isModalVisible !== this.props.isModalVisible
        ) {
            this.setState(this.getInitialState()); // reset state
        }

        // Update operation
        if (
            operation &&
            operation.type === "update" &&
            operation.payload.id !== prevState.permissionId
        ) {
            const toAccount = ChainStore.getAccount(
                operation.payload.authorized_account
            );

            if (toAccount && toAccount.get) {
                this.setState({
                    to_account: toAccount,
                    to_name: toAccount.get("name"),
                    asset: ChainStore.getAsset(
                        operation.payload.withdrawal_limit.asset_id
                    ),
                    permissionId: operation.payload.id,
                    amount: operation.payload.withdrawal_limit.amount,
                    asset_id: operation.payload.withdrawal_limit.asset_id
                });
            }
        }
    }

    _checkBalance() {
        const {feeAmount, amount, from_account, asset} = this.state;
        if (!asset || !from_account) return;
        this._updateFee();
        const balanceID = from_account.getIn(["balances", asset.get("id")]);
        const feeBalanceID = from_account.getIn([
            "balances",
            feeAmount.asset_id
        ]);
        if (!asset || !from_account) return;
        if (!balanceID) return this.setState({balanceError: true});
        let balanceObject = ChainStore.getObject(balanceID);
        let feeBalanceObject = feeBalanceID
            ? ChainStore.getObject(feeBalanceID)
            : null;
        if (!feeBalanceObject || feeBalanceObject.get("balance") === 0) {
            this.setState({fee_asset_id: "1.3.0"}, this._updateFee);
        }
        if (!balanceObject || !feeAmount) return;
        if (!amount) return this.setState({balanceError: false});
        const hasBalance = checkBalance(
            amount,
            asset,
            feeAmount,
            balanceObject
        );
        if (hasBalance === null) return;
        this.setState({balanceError: !hasBalance});
    }

    _checkFeeStatus(state = this.state) {
        let {from_account, open} = state;
        if (!from_account || !open) return;

        const assets = Object.keys(from_account.get("balances").toJS()).sort(
            utils.sortID
        );
        let feeStatus = {};
        let p = [];
        assets.forEach(a => {
            p.push(
                checkFeeStatusAsync({
                    accountID: from_account.get("id"),
                    feeID: a,
                    options: ["price_per_kbyte"],
                    data: {
                        type: "memo", // TODO: pick correct type
                        content: null
                    }
                })
            );
        });
        Promise.all(p)
            .then(status => {
                assets.forEach((a, idx) => {
                    feeStatus[a] = status[idx];
                });
                if (!utils.are_equal_shallow(this.state.feeStatus, feeStatus)) {
                    this.setState({
                        feeStatus
                    });
                }
                this._checkBalance();
            })
            .catch(err => {
                console.error(err);
            });
    }

    _setTotal(asset_id, balance_id) {
        const {feeAmount} = this.state;
        let balanceObject = ChainStore.getObject(balance_id);
        let transferAsset = ChainStore.getObject(asset_id);

        let balance = new Asset({
            amount: balanceObject.get("balance"),
            asset_id: transferAsset.get("id"),
            precision: transferAsset.get("precision")
        });

        if (balanceObject) {
            if (feeAmount.asset_id === balance.asset_id) {
                balance.minus(feeAmount);
            }
            this.setState(
                {maxAmount: true, amount: balance.getAmount({real: true})},
                this._checkBalance
            );
        }
    }

    _getAvailableAssets(state = this.state) {
        const {feeStatus} = this.state;
        function hasFeePoolBalance(id) {
            if (feeStatus[id] === undefined) return true;
            return feeStatus[id] && feeStatus[id].hasPoolBalance;
        }

        function hasBalance(id) {
            if (feeStatus[id] === undefined) return true;
            return feeStatus[id] && feeStatus[id].hasBalance;
        }
        const {from_account} = state;
        let asset_types = [],
            fee_asset_types = [];
        if (!(from_account && from_account.get("balances"))) {
            return {asset_types, fee_asset_types};
        }
        let account_balances = state.from_account.get("balances").toJS();
        asset_types = Object.keys(account_balances).sort(utils.sortID);
        fee_asset_types = Object.keys(account_balances).sort(utils.sortID);
        for (let key in account_balances) {
            let balanceObject = ChainStore.getObject(account_balances[key]);
            if (balanceObject && balanceObject.get("balance") === 0) {
                asset_types.splice(asset_types.indexOf(key), 1);
                if (fee_asset_types.indexOf(key) !== -1) {
                    fee_asset_types.splice(fee_asset_types.indexOf(key), 1);
                }
            }
        }

        fee_asset_types = fee_asset_types.filter(a => {
            return hasFeePoolBalance(a) && hasBalance(a);
        });

        return {asset_types, fee_asset_types};
    }

    _updateFee(state = this.state) {
        if (!this.props.isModalVisible) return;

        let {fee_asset_id, from_account, asset_id} = state;
        const {fee_asset_types} = this._getAvailableAssets(state);
        if (
            fee_asset_types.length === 1 &&
            fee_asset_types[0] !== fee_asset_id
        ) {
            fee_asset_id = fee_asset_types[0];
        }
        if (!from_account) return null;
        checkFeeStatusAsync({
            accountID: from_account.get("id"),
            feeID: fee_asset_id,
            options: ["price_per_kbyte"],
            data: {
                type: "memo", // TODO: pick correct type
                content: null
            }
        }).then(({fee, hasBalance, hasPoolBalance}) => {
            shouldPayFeeWithAssetAsync(from_account, fee).then(
                should =>
                    should
                        ? this.setState(
                              {fee_asset_id: asset_id},
                              this._updateFee
                          )
                        : this.setState({
                              feeAmount: fee,
                              fee_asset_id: fee.asset_id,
                              hasBalance,
                              hasPoolBalance,
                              error: !hasBalance || !hasPoolBalance
                          })
            );
        });
    }

    onToAccountChanged = to_account => {
        this.setState({to_account, error: null});
    };

    onAmountChanged = ({amount, asset}) => {
        if (!asset) {
            return;
        }
        //console.log("amount changed", amount, asset);

        this.setState(
            {
                amount,
                asset,
                asset_id: asset.get("id"),
                error: null,
                maxAmount: false
            },
            this._checkBalance
        );
    };

    toChanged = to_name => {
        this.setState({to_name, error: null});
    };

    onFeeChanged({asset}) {
        this.setState(
            {feeAsset: asset, fee_asset_id: asset.get("id"), error: null},
            this._updateFee
        );
    }

    onTrxIncluded(confirm_store_state) {
        if (
            confirm_store_state.included &&
            confirm_store_state.broadcasted_transaction
        ) {
            // this.setState(Transfer.getInitialState());
            TransactionConfirmStore.unlisten(this.onTrxIncluded);
            TransactionConfirmStore.reset();
        } else if (confirm_store_state.closed) {
            TransactionConfirmStore.unlisten(this.onTrxIncluded);
            TransactionConfirmStore.reset();
        }
    }

    onNumOfPeriodsChanged = e => {
        let newValue = parseInt(e.target.value, 10);
        if (!isNaN(newValue) && typeof newValue === "number") {
            this.setState({num_of_periods: newValue});
        }
    };

    render() {
        let {
            from_account,
            to_account,
            asset,
            asset_id,
            feeAmount,
            amount,
            error,
            to_name,
            feeAsset,
            fee_asset_id,
            balanceError,
            num_of_periods,
            period,
            period_start_time
        } = this.state;

        const {operation} = this.props;

        let {asset_types, fee_asset_types} = this._getAvailableAssets();

        let balance = null;
        let balance_fee = null;

        // Estimate fee
        let fee = this.state.feeAmount.getAmount({real: true});

        if (from_account && from_account.get("balances")) {
            let account_balances = from_account.get("balances").toJS();
            let _error = this.state.balanceError ? "has-error" : "";
            if (asset_types.length === 1)
                asset = ChainStore.getAsset(asset_types[0]);
            if (asset_types.length > 0) {
                let current_asset_id = asset ? asset.get("id") : asset_types[0];
                let feeID = feeAsset ? feeAsset.get("id") : "1.3.0";

                balance = (
                    <span>
                        <Translate
                            component="span"
                            content="transfer.available"
                        />
                        :{" "}
                        <span
                            className={_error}
                            style={{
                                borderBottom: "#A09F9F 1px dotted",
                                cursor: "pointer"
                            }}
                            onClick={this._setTotal.bind(
                                this,
                                current_asset_id,
                                account_balances[current_asset_id],
                                fee,
                                feeID
                            )}
                        >
                            <BalanceComponent
                                balance={account_balances[current_asset_id]}
                            />
                        </span>
                    </span>
                );

                if (feeID == current_asset_id && this.state.balanceError) {
                    balance_fee = (
                        <span>
                            <span className={_error}>
                                <Translate content="transfer.errors.insufficient" />
                            </span>
                        </span>
                    );
                }
            } else {
                balance = (
                    <span>
                        <span className={_error}>
                            <Translate content="transfer.errors.noFunds" />
                        </span>
                    </span>
                );
                balance_fee = (
                    <span>
                        <span className={_error}>
                            <Translate content="transfer.errors.noFunds" />
                        </span>
                    </span>
                );
            }
        }

        const amountValue = parseFloat(
            String.prototype.replace.call(amount, /,/g, "")
        );
        const isAmountValid = amountValue && !isNaN(amountValue);
        const isSubmitNotValid =
            !from_account ||
            !to_account ||
            !isAmountValid ||
            !asset ||
            balanceError ||
            from_account.get("id") == to_account.get("id") ||
            !period.amount ||
            !num_of_periods ||
            !period_start_time;
        return (
            <Modal
                title={counterpart.translate(
                    "showcases.direct_debit.claim_funds"
                )}
                visible={this.props.isModalVisible}
                overlay={true}
                onCancel={this.props.hideModal}
                footer={[
                    <Button
                        key={"send"}
                        disabled={isSubmitNotValid}
                        onClick={
                            !isSubmitNotValid ? this.onSubmit.bind(this) : null
                        }
                    >
                        {counterpart.translate("showcases.direct_debit.claim")}
                    </Button>,
                    <Button key="Cancel" onClick={this.props.hideModal}>
                        <Translate component="span" content="transfer.cancel" />
                    </Button>
                ]}
            >
                <div className="grid-block vertical no-overflow">
                    <form noValidate style={{paddingBottom: "50px"}}>
                        <div>
                            {/* AUTHORIZED ACCOUNT */}
                            <div className="content-block">
                                <AccountSelector
                                    label="showcases.direct_debit.authorized_account"
                                    accountName={to_name}
                                    account={to_account}
                                    onChange={this.toChanged.bind(this)}
                                    onAccountChanged={this.onToAccountChanged}
                                    size={60}
                                    typeahead={true}
                                    hideImage
                                />
                            </div>
                        </div>
                        <div className="content-block transfer-input">
                            {/*  LIMIT */}
                            <AmountSelector
                                label="showcases.direct_debit.limit_per_period"
                                amount={amount}
                                onChange={this.onAmountChanged}
                                asset={
                                    asset_types.length > 0 && asset
                                        ? asset.get("id")
                                        : asset_id
                                            ? asset_id
                                            : asset_types[0]
                                }
                                assets={asset_types}
                                display_balance={balance}
                                allowNaN={true}
                            />
                        </div>

                        <div className="content-block transfer-input">
                            <div className="no-margin no-padding">
                                {/*  F E E  */}
                                <div id="txFeeSelector" className="small-12">
                                    <AmountSelector
                                        label="transfer.fee"
                                        disabled={true}
                                        amount={fee}
                                        onChange={this.onFeeChanged.bind(this)}
                                        asset={
                                            fee_asset_types.length && feeAmount
                                                ? feeAmount.asset_id
                                                : fee_asset_types.length === 1
                                                    ? fee_asset_types[0]
                                                    : fee_asset_id
                                                        ? fee_asset_id
                                                        : fee_asset_types[0]
                                        }
                                        assets={fee_asset_types}
                                        display_balance={balance_fee}
                                        // tabIndex={tabIndex++}
                                        error={
                                            this.state.hasPoolBalance === false
                                                ? "transfer.errors.insufficient"
                                                : null
                                        }
                                        scroll_length={2}
                                    />
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
            </Modal>
        );
    }
}

export default connect(
    DirectDebitClaimModal,
    {
        listenTo() {
            return [AccountStore];
        },
        getProps() {
            return {
                currentAccount: AccountStore.getState().currentAccount,
                passwordAccount: AccountStore.getState().passwordAccount
            };
        }
    }
);
