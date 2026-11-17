"""API do Serverless Expense Tracker.

Uma unica funcao Lambda atende todas as rotas da HTTP API. O usuario e
identificado pelo claim `sub` do JWT do Cognito, validado pelo API Gateway
antes da Lambda ser chamada; cada usuario so enxerga as proprias despesas.
"""

import json
import logging
import os
import re
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

import boto3
from boto3.dynamodb.conditions import Attr, Key

CATEGORIES = {
    "alimentacao", "transporte", "moradia", "saude", "lazer",
    "educacao", "compras", "contas", "outros",
}
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_AMOUNT = Decimal("1000000")

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_table = None


def table():
    """Cria o recurso sob demanda (facilita os testes com moto)."""
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _table


# ------------------------------------------------------------------ helpers
class ValidationError(Exception):
    pass


def response(status, body=None):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body if body is not None else {}, default=_json_default),
    }


def _json_default(value):
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Tipo nao serializavel: {type(value)}")


def user_id(event):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    sub = claims.get("sub")
    if not sub:
        raise PermissionError("Usuario nao autenticado")
    return sub


def parse_body(event):
    try:
        return json.loads(event.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise ValidationError("JSON invalido") from exc


def validate_expense(data, partial=False):
    """Valida e normaliza os campos de uma despesa."""
    clean = {}

    if "amount" in data or not partial:
        try:
            amount = Decimal(str(data.get("amount"))).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError):
            raise ValidationError("amount deve ser numerico")
        if amount <= 0 or amount > MAX_AMOUNT:
            raise ValidationError("amount deve ser maior que 0 e menor que 1.000.000")
        clean["amount"] = amount

    if "description" in data or not partial:
        desc = str(data.get("description") or "").strip()
        if not 1 <= len(desc) <= 120:
            raise ValidationError("description deve ter entre 1 e 120 caracteres")
        clean["description"] = desc

    if "category" in data or not partial:
        cat = str(data.get("category") or "").strip().lower()
        if cat not in CATEGORIES:
            raise ValidationError(f"category deve ser uma de: {', '.join(sorted(CATEGORIES))}")
        clean["category"] = cat

    if "date" in data or not partial:
        raw = str(data.get("date") or "")
        try:
            clean["date"] = date.fromisoformat(raw).isoformat()
        except ValueError:
            raise ValidationError("date deve estar no formato AAAA-MM-DD")

    if partial and not clean:
        raise ValidationError("Nenhum campo para atualizar")
    return clean


def to_public(item):
    return {
        "id": item["sk"].removeprefix("EXP#"),
        "amount": item["amount"],
        "description": item["description"],
        "category": item["category"],
        "date": item["date"],
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }


def query_user_expenses(uid, month=None):
    kwargs = {"KeyConditionExpression": Key("userId").eq(uid) & Key("sk").begins_with("EXP#")}
    if month:
        kwargs["FilterExpression"] = Attr("date").begins_with(month)
    items = []
    while True:
        page = table().query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return items


def get_month(event):
    month = (event.get("queryStringParameters") or {}).get("month")
    if month and not MONTH_RE.match(month):
        raise ValidationError("month deve estar no formato AAAA-MM")
    return month


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------ rotas
def list_expenses(event, uid):
    items = query_user_expenses(uid, get_month(event))
    items.sort(key=lambda i: (i["date"], i.get("createdAt", "")), reverse=True)
    return response(200, {"items": [to_public(i) for i in items]})


def create_expense(event, uid):
    data = validate_expense(parse_body(event))
    expense_id = str(uuid.uuid4())
    ts = now_iso()
    item = {"userId": uid, "sk": f"EXP#{expense_id}", **data, "createdAt": ts, "updatedAt": ts}
    table().put_item(Item=item)
    return response(201, to_public(item))


def update_expense(event, uid):
    expense_id = event["pathParameters"]["id"]
    data = validate_expense(parse_body(event), partial=True)
    data["updatedAt"] = now_iso()

    names = {f"#{k}": k for k in data}
    values = {f":{k}": v for k, v in data.items()}
    try:
        result = table().update_item(
            Key={"userId": uid, "sk": f"EXP#{expense_id}"},
            UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in data),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(sk)",
            ReturnValues="ALL_NEW",
        )
    except table().meta.client.exceptions.ConditionalCheckFailedException:
        return response(404, {"message": "Despesa nao encontrada"})
    return response(200, to_public(result["Attributes"]))


def delete_expense(event, uid):
    expense_id = event["pathParameters"]["id"]
    try:
        table().delete_item(
            Key={"userId": uid, "sk": f"EXP#{expense_id}"},
            ConditionExpression="attribute_exists(sk)",
        )
    except table().meta.client.exceptions.ConditionalCheckFailedException:
        return response(404, {"message": "Despesa nao encontrada"})
    return response(204)


def summary(event, uid):
    month = get_month(event) or date.today().strftime("%Y-%m")
    items = query_user_expenses(uid, month)
    by_category = {}
    for item in items:
        by_category[item["category"]] = by_category.get(item["category"], Decimal("0")) + item["amount"]
    total = sum(by_category.values(), Decimal("0"))
    return response(200, {
        "month": month,
        "total": total,
        "count": len(items),
        "byCategory": dict(sorted(by_category.items(), key=lambda kv: kv[1], reverse=True)),
    })


ROUTES = {
    "GET /expenses": list_expenses,
    "POST /expenses": create_expense,
    "PUT /expenses/{id}": update_expense,
    "DELETE /expenses/{id}": delete_expense,
    "GET /summary": summary,
}


def handler(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if route is None:
        return response(404, {"message": "Rota nao encontrada"})
    try:
        return route(event, user_id(event))
    except PermissionError as exc:
        return response(401, {"message": str(exc)})
    except ValidationError as exc:
        return response(400, {"message": str(exc)})
    except Exception:  # noqa: BLE001 - loga o erro e responde sem vazar detalhes
        logger.exception("Erro inesperado na rota %s", event.get("routeKey"))
        return response(500, {"message": "Erro interno"})
