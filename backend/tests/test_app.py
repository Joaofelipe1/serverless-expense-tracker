import json
import os
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ["TABLE_NAME"] = "expenses-test"

import app  # noqa: E402


@pytest.fixture(autouse=True)
def dynamodb():
    with mock_aws():
        boto3.resource("dynamodb").create_table(
            TableName="expenses-test",
            KeySchema=[
                {"AttributeName": "userId", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "userId", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        app._table = None
        yield
        app._table = None


def event(route, body=None, user="user-a", path=None, query=None):
    return {
        "routeKey": route,
        "body": json.dumps(body) if body is not None else None,
        "pathParameters": path,
        "queryStringParameters": query,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": user}}}},
    }


def call(*args, **kwargs):
    res = app.handler(event(*args, **kwargs), None)
    return res["statusCode"], json.loads(res["body"])


VALID = {"amount": 42.5, "description": "Mercado", "category": "alimentacao", "date": "2026-10-10"}


def test_create_and_list():
    status, created = call("POST /expenses", VALID)
    assert status == 201
    assert created["amount"] == 42.5 and created["id"]

    status, body = call("GET /expenses")
    assert status == 200
    assert [i["id"] for i in body["items"]] == [created["id"]]


def test_users_are_isolated():
    call("POST /expenses", VALID, user="user-a")
    _, body = call("GET /expenses", user="user-b")
    assert body["items"] == []


@pytest.mark.parametrize("field,value", [
    ("amount", -1), ("amount", "abc"), ("category", "foguete"),
    ("date", "10/10/2026"), ("description", ""),
])
def test_validation(field, value):
    status, body = call("POST /expenses", {**VALID, field: value})
    assert status == 400
    assert field in body["message"]


def test_update_and_delete():
    _, created = call("POST /expenses", VALID)
    eid = created["id"]

    status, updated = call("PUT /expenses/{id}", {"amount": 10}, path={"id": eid})
    assert status == 200 and updated["amount"] == 10
    assert updated["description"] == "Mercado"

    status, _ = call("DELETE /expenses/{id}", path={"id": eid})
    assert status == 204
    status, _ = call("DELETE /expenses/{id}", path={"id": eid})
    assert status == 404


def test_cannot_touch_other_users_expense():
    _, created = call("POST /expenses", VALID, user="user-a")
    status, _ = call("PUT /expenses/{id}", {"amount": 1}, user="user-b", path={"id": created["id"]})
    assert status == 404


def test_month_filter_and_summary():
    call("POST /expenses", VALID)
    call("POST /expenses", {**VALID, "amount": 7.5, "category": "transporte"})
    call("POST /expenses", {**VALID, "date": "2026-09-01"})

    _, body = call("GET /expenses", query={"month": "2026-10"})
    assert len(body["items"]) == 2

    status, s = call("GET /summary", query={"month": "2026-10"})
    assert status == 200
    assert s["total"] == 50 and s["count"] == 2
    assert list(s["byCategory"]) == ["alimentacao", "transporte"]


def test_invalid_month():
    status, _ = call("GET /summary", query={"month": "2026-13"})
    assert status == 400


def test_unauthenticated():
    res = app.handler({"routeKey": "GET /expenses", "requestContext": {}}, None)
    assert res["statusCode"] == 401
