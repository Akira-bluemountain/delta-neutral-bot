"""
Extended (x10) Stark 署名サービス
TypeScript Bot から HTTP 経由で呼び出される
"""
import os
import asyncio
import logging
from decimal import Decimal
from datetime import datetime, timezone
from flask import Flask, request, jsonify

from x10.perpetual.accounts import StarkPerpetualAccount
from x10.perpetual.configuration import MAINNET_CONFIG
from x10.perpetual.order_object import create_order_object
from x10.perpetual.orders import OrderSide, OrderType, TimeInForce
from x10.perpetual.trading_client import PerpetualTradingClient
from x10.utils.http import X10Error, RateLimitException

try:
    import aiohttp
    _NETWORK_EXCEPTIONS = (aiohttp.ClientError, asyncio.TimeoutError, OSError)
except ImportError:
    _NETWORK_EXCEPTIONS = (asyncio.TimeoutError, OSError)


def classify_sdk_error(err: Exception) -> str:
    """
    SDK 例外を 'rejected'(取引所が明確に拒否) と 'ambiguous'(送達不明) に分類。
    Phase 1 重複発注対策の根幹: ambiguous は呼び出し側で外部ID検証フローへ。
    """
    if isinstance(err, _NETWORK_EXCEPTIONS):
        return "ambiguous"
    if isinstance(err, RateLimitException):
        return "ambiguous"
    if isinstance(err, X10Error):
        # X10Error は HTTP レスポンスを受領した上での venue 側拒否
        return "rejected"
    return "ambiguous"

logging.basicConfig(level=logging.INFO)
LOG = logging.getLogger("signer")

app = Flask(__name__)

# 起動時の環境変数検証はスキップ（マルチユーザー: 認証情報はリクエストボディで受け取る）
# 後方互換: 環境変数が設定されていればフォールバックとして使用
_ENV_FALLBACK = {
    "api_key": os.getenv("EXTENDED_API_KEY"),
    "stark_private_key": os.getenv("EXTENDED_STARK_PRIVATE_KEY"),
    "stark_public_key": os.getenv("EXTENDED_STARK_PUBLIC_KEY"),
    "vault_id": os.getenv("EXTENDED_VAULT_ID"),
}


def get_stark_account(data: dict = None) -> StarkPerpetualAccount:
    """
    リクエストボディの認証情報からアカウント作成（マルチユーザー対応）。
    ボディに認証情報がなければ環境変数にフォールバック（後方互換）。
    """
    if data and data.get("starkPrivateKey"):
        return StarkPerpetualAccount(
            vault=int(data["vaultId"]),
            private_key=data["starkPrivateKey"],
            public_key=data["starkPublicKey"],
            api_key=data["apiKey"],
        )
    # 環境変数フォールバック
    if not _ENV_FALLBACK["api_key"]:
        raise RuntimeError("認証情報がリクエストにも環境変数にもありません")
    return StarkPerpetualAccount(
        vault=int(_ENV_FALLBACK["vault_id"]),
        private_key=_ENV_FALLBACK["stark_private_key"],
        public_key=_ENV_FALLBACK["stark_public_key"],
        api_key=_ENV_FALLBACK["api_key"],
    )


def run_async(coro):
    """各呼び出しで新しいイベントループを作成して実行し、必ずクリーンアップ"""
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)
    finally:
        # 保留中のタスクをキャンセル
        pending = asyncio.all_tasks(loop)
        for task in pending:
            task.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()
        asyncio.set_event_loop(None)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "ext-signer"})


@app.route("/place-order", methods=["POST"])
def place_order():
    """
    署名+発注を一括実行
    呼び出し側は externalId（client-generated UUID）を必須で渡し、
    冪等性・検証のキーとして利用する。
    """
    data = request.get_json()

    try:
        market_name = data["market"]
        side = OrderSide.BUY if data["side"] == "BUY" else OrderSide.SELL
        size = Decimal(str(data["size"]))
        price = Decimal(str(data["price"]))
        post_only = data.get("postOnly", False)
        reduce_only = data.get("reduceOnly", False)
        tif_str = data.get("timeInForce", "GTT")
        tif = TimeInForce.IOC if tif_str == "IOC" else TimeInForce.GTT
        order_type = (
            OrderType.MARKET if data.get("orderType") == "MARKET" else OrderType.LIMIT
        )
        # externalId は冪等性キー。呼び出し側で必ず生成して渡す
        external_id = data.get("externalId")
        if not external_id:
            return jsonify({
                "success": False,
                "error": "externalId は必須（冪等性キー）",
                "classification": "rejected",
            }), 400

        async def run():
            stark_account = get_stark_account(data)
            client = PerpetualTradingClient(MAINNET_CONFIG, stark_account)
            try:
                markets = await client.markets_info.get_markets_dict()
                market = markets[market_name]

                order = create_order_object(
                    account=stark_account,
                    market=market,
                    amount_of_synthetic=size,
                    price=price,
                    side=side,
                    starknet_domain=MAINNET_CONFIG.starknet_domain,
                    order_type=order_type,
                    post_only=post_only,
                    reduce_only=reduce_only,
                    time_in_force=tif,
                    order_external_id=external_id,
                )
                placed = await client.orders.place_order(order=order)

                # Phase 3: place_order 直後に fill 情報を取得
                # PlacedOrderModel には id/external_id しかないため、
                # get_order_by_external_id で実約定量を取得する
                # IOC注文は即座に処理されるが、APIの反映に若干のラグがあるため
                # 最大2回（1秒間隔）リトライする
                fill_info = {"filledQty": None, "averagePrice": None, "status": None}
                for attempt in range(2):
                    try:
                        if attempt > 0:
                            await asyncio.sleep(1)
                        detail_resp = await client.account.get_order_by_external_id(
                            external_id=external_id
                        )
                        detail_orders = detail_resp.data or []
                        if detail_orders:
                            o = detail_orders[0] if isinstance(detail_orders, list) else detail_orders
                            fq = o.filled_qty
                            fill_info["filledQty"] = str(fq) if fq is not None else "0"
                            fill_info["averagePrice"] = str(o.average_price) if o.average_price is not None else None
                            fill_info["status"] = str(o.status) if o.status is not None else None
                            # filled_qty が取得できたらリトライ不要
                            if fq is not None and fq > 0:
                                break
                    except Exception as detail_err:
                        LOG.warning(f"fill情報取得失敗 attempt={attempt}: {detail_err}")

                return placed, fill_info
            finally:
                # セッションクリーンアップ
                try:
                    session = await client._PerpetualTradingClient__get_session()
                    if session and not session.closed:
                        await session.close()
                except Exception:
                    pass

        placed, fill_info = run_async(run())

        return jsonify({
            "success": True,
            "orderId": str(placed.data.id),
            "externalId": str(placed.data.external_id),
            "filledQty": fill_info["filledQty"],
            "averagePrice": fill_info["averagePrice"],
            "orderStatus": fill_info["status"],
        })

    except Exception as e:
        LOG.exception(f"place-order 失敗: {e}")
        classification = classify_sdk_error(e)
        return jsonify({
            "success": False,
            "error": str(e),
            "errorType": type(e).__name__,
            "classification": classification,
        }), 500


@app.route("/get-order-by-external-id/<external_id>", methods=["GET"])
def get_order_by_external_id(external_id):
    """
    externalId で注文を取引所側から照会（送信失敗時の検証用）
    found=True なら取引所側で受領済み、found=False なら未受領が確定
    """
    try:
        # GET パラメータでユーザー認証情報を受け取る（内部ネットワーク専用）
        cred_data = {
            "apiKey": request.args.get("apiKey"),
            "starkPrivateKey": request.args.get("starkPrivateKey"),
            "starkPublicKey": request.args.get("starkPublicKey"),
            "vaultId": request.args.get("vaultId"),
        }

        async def run():
            stark_account = get_stark_account(cred_data if cred_data.get("apiKey") else None)
            client = PerpetualTradingClient(MAINNET_CONFIG, stark_account)
            try:
                resp = await client.account.get_order_by_external_id(
                    external_id=external_id
                )
                return resp
            finally:
                try:
                    session = await client._PerpetualTradingClient__get_session()
                    if session and not session.closed:
                        await session.close()
                except Exception:
                    pass

        resp = run_async(run())
        orders = resp.data or []

        if not orders:
            return jsonify({"found": False})

        # 通常 1件のみ。複数あれば最新を採用
        o = orders[0] if isinstance(orders, list) else orders
        return jsonify({
            "found": True,
            "orderId": str(o.id),
            "externalId": str(o.external_id),
            "status": str(o.status),
            "filledQty": str(o.filled_qty) if o.filled_qty is not None else "0",
            "qty": str(o.qty),
            "averagePrice": str(o.average_price) if o.average_price is not None else None,
            "side": str(o.side),
            "market": o.market,
        })
    except Exception as e:
        LOG.exception(f"get-order-by-external-id 失敗: {e}")
        return jsonify({"found": None, "error": str(e)}), 500


@app.route("/cancel-order", methods=["POST"])
def cancel_order():
    data = request.get_json()
    order_id = data.get("orderId")
    external_id = data.get("externalId")

    try:
        async def run():
            stark_account = get_stark_account(data)
            client = PerpetualTradingClient(MAINNET_CONFIG, stark_account)
            try:
                if order_id:
                    await client.orders.cancel_order(order_id=int(order_id))
                elif external_id:
                    await client.orders.cancel_order_by_external_id(
                        order_external_id=external_id
                    )
                else:
                    raise ValueError("orderId または externalId が必要")
            finally:
                try:
                    session = await client._PerpetualTradingClient__get_session()
                    if session and not session.closed:
                        await session.close()
                except Exception:
                    pass

        run_async(run())
        return jsonify({"success": True})

    except Exception as e:
        LOG.exception(f"cancel-order 失敗: {e}")
        return jsonify({"success": False, "error": str(e)}), 500
