import json
import logging

import main


canaries = {
    "json": "json-quoted-secret-canary",
    "repr": "repr-dict-secret-canary",
    "repr_string": "repr-string-secret-canary",
    "nested": "nested-secret-canary",
    "tuple": "tuple-secret-canary",
    "args_mapping": "args-mapping-secret-canary",
    "args_json": "args-json-secret-canary",
    "args_positional": "args-positional-secret-canary",
    "prefixed": "prefixed-json-secret-canary",
    "double_json": "double-json-secret-canary",
    "prefixed_double_json": "prefixed-double-json-secret-canary",
    "escaped_json": "escaped-json-suffix-secret-canary",
    "url_comma": "url-comma-suffix-secret-canary",
    "url_semicolon": "url-semicolon-suffix-secret-canary",
    "ipv6_path": "ipv6-path-secret-canary",
    "ipv6_query": "ipv6-query-secret-canary",
    "bearer_comma": "bearer-comma-suffix-secret-canary",
    "bearer_semicolon": "bearer-semicolon-suffix-secret-canary",
    "token_delimiter": "token-delimiter-suffix-secret-canary",
    "basic_auth": "basic-auth-secret-canary",
    "proxy_auth": "proxy-auth-secret-canary",
    "digest_auth": "digest-auth-secret-canary",
    "aws4_auth": "aws4-auth-secret-canary",
    "cookie_first": "cookie-first-secret-canary",
    "cookie_second": "cookie-second-secret-canary",
    "namespace_basic": "namespace-basic-secret-canary",
    "namespace_digest": "namespace-digest-secret-canary",
    "namespace_cookie": "namespace-cookie-secret-canary",
    "folded_auth": "folded-auth-secret-canary",
    "folded_cookie": "folded-cookie-secret-canary",
    "policy_auth": "policy-auth-secret-canary",
    "policy_cookie": "policy-cookie-secret-canary",
    "assignment_comma": "assignment-comma-suffix-secret-canary",
    "assignment_semicolon": "assignment-semicolon-suffix-secret-canary",
    "malformed_url": "malformed-url-secret-canary",
    "postgres_uri": "postgres-uri-secret-canary",
    "mysql_uri": "mysql-uri-secret-canary",
    "redis_uri": "redis-uri-secret-canary",
    "amqp_uri": "amqp-uri-secret-canary",
    "encoded_key": "encoded-key-secret-canary",
    "signature_map": "signature-map-secret-canary",
    "amz_signature_map": "amz-signature-map-secret-canary",
    "auth_map": "auth-map-secret-canary",
    "authentication_map": "authentication-map-secret-canary",
    "unicode_repr": "unicode-repr-secret-canary",
    "idempotent": "idempotent-secret-canary",
    "whitespace_password": "whitespace-password-secret-canary",
    "whitespace_secret": "whitespace-secret-secret-canary",
    "whitespace_credential": "whitespace-credential-secret-canary",
    "whitespace_authorization": "whitespace-authorization-secret-canary",
    "cycle": "cycle-secret-canary",
    "deep": "deep-secret-canary",
    "late_item": "late-item-secret-canary",
    "long": "long-text-secret-canary",
    "long_double": "long-double-json-secret-canary",
    "exception": "exception-secret-canary",
    "stack": "stack-secret-canary",
    "stack_text": "stack-text-secret-canary",
    "fail_closed": "fail-closed-secret-canary",
}

main.logger.error(
    json.dumps(
        {
            "vendorSigningKey": canaries["json"],
            "safeField": "json-safe-marker",
        }
    )
)
main.logger.error(
    {
        "anotherServiceKey": canaries["repr"],
        "safeField": "repr-safe-marker",
    }
)
main.logger.error(
    repr(
        {
            "privateSigningKey": canaries["repr_string"],
            "safeField": "repr-string-safe-marker",
        }
    )
)
main.logger.error(
    {
        "nested": [
            {
                "paperlessToken": canaries["nested"],
                "safeField": "nested-safe-marker",
            },
            {
                "items": (
                    {
                        "sessionCookie": canaries["tuple"],
                        "safeField": "tuple-safe-marker",
                    },
                )
            },
        ]
    }
)
main.logger.info(
    "Logger args payload: %s | %s",
    {
        "config": {
            "customApiKey": canaries["args_mapping"],
            "safeField": "args-mapping-safe-marker",
        },
    },
    json.dumps(
        {
            "serviceAuthorization": canaries["args_json"],
            "safeField": "args-json-safe-marker",
        }
    ),
)
main.logger.error(
    "Mapping args payload: %(safeField)s %(vendorSigningKey)s",
    {
        "safeField": "mapping-format-safe-marker",
        "vendorSigningKey": canaries["args_mapping"],
    },
)
main.logger.error(
    "Inline positional token=%s safeField=%s",
    canaries["args_positional"],
    "args-positional-safe-marker",
)
main.logger.error(
    "Prefixed JSON payload: "
    + json.dumps(
        {
            "databasePassword": canaries["prefixed"],
            "safeField": "prefixed-safe-marker",
        }
    )
)
double_json_payload = json.dumps(
    {
        "password": canaries["double_json"],
        "safeField": "double-json-safe-marker",
    }
)
double_json_input = json.dumps(double_json_payload)
double_json_once = main._sanitize_log_text(double_json_input)
assert double_json_once == main._sanitize_log_text(double_json_once)
assert canaries["double_json"] not in double_json_once
main.logger.error(double_json_input)
main.logger.error(
    "Prefixed double JSON payload: "
    + json.dumps(
        json.dumps(
            {
                "password": canaries["prefixed_double_json"],
                "safeField": "prefixed-double-json-safe-marker",
            }
        )
    )
)
main.logger.error(
    "Escaped JSON payload: "
    + json.dumps(
        {
            "databasePassword": (
                "prefix-" + chr(92) + chr(34) + canaries["escaped_json"]
            ),
            "safeField": "escaped-json-safe-marker",
        }
    )
)
main.logger.error(
    "url-delimiter-safe-marker %s",
    (
        "https://user:prefix,"
        f"{canaries['url_comma']};{canaries['url_semicolon']}"
        "@paperless.example/private"
    ),
)
main.logger.error(
    "ipv6-safe-marker %s",
    (
        "http://[2001:db8::1]:8443/"
        f"{canaries['ipv6_path']}?token={canaries['ipv6_query']}"
    ),
)
main.logger.error(
    "bearer-safe-marker Authorization: Bearer prefix,%s;%s",
    canaries["bearer_comma"],
    canaries["bearer_semicolon"],
)
main.logger.error(
    "token-safe-marker Authorization: Token prefix,%s",
    canaries["token_delimiter"],
)
main.logger.error(
    "basic-auth-safe-marker Authorization: Basic %s",
    canaries["basic_auth"],
)
main.logger.error(
    "proxy-auth-safe-marker Proxy-Authorization: Basic %s",
    canaries["proxy_auth"],
)
main.logger.error(
    'digest-auth-safe-marker Authorization: Digest username="user", response="%s"',
    canaries["digest_auth"],
)
main.logger.error(
    "aws4-auth-safe-marker Authorization header "
    "AWS4-HMAC-SHA256 Credential=test, Signature=%s",
    canaries["aws4_auth"],
)
main.logger.error(
    "cookie-safe-marker Cookie: first=%s; second=%s",
    canaries["cookie_first"],
    canaries["cookie_second"],
)
main.logger.error(
    "namespace-basic-safe-marker request.headers.Authorization: Basic %s",
    canaries["namespace_basic"],
)
main.logger.error(
    (
        "namespace-digest-safe-marker "
        "http.request.header.authorization: Digest response=%s"
    ),
    canaries["namespace_digest"],
)
main.logger.error(
    "namespace-cookie-safe-marker request.headers.Cookie: first=ONE; second=%s",
    canaries["namespace_cookie"],
)
main.logger.error(
    "folded-auth-safe-marker Authorization: Basic\n %s",
    canaries["folded_auth"],
)
main.logger.error(
    "folded-cookie-safe-marker Cookie: first=ONE;\n second=%s",
    canaries["folded_cookie"],
)
main.logger.error(
    "explicit-policy-auth-safe-marker Authorization: policy %s",
    canaries["policy_auth"],
)
main.logger.error(
    "explicit-policy-cookie-safe-marker Cookie: policy=%s",
    canaries["policy_cookie"],
)
main.logger.error(
    "assignment-safe-marker password=prefix,%s;%s",
    canaries["assignment_comma"],
    canaries["assignment_semicolon"],
)
main.logger.error(
    "malformed-url-safe-marker https://user:%s",
    canaries["malformed_url"],
)
main.logger.error(
    "postgres-uri-safe-marker postgresql://user:%s@db.example/app",
    canaries["postgres_uri"],
)
main.logger.error(
    "mysql-uri-safe-marker mysql://user:%s@db.example/app",
    canaries["mysql_uri"],
)
main.logger.error(
    "redis-uri-safe-marker redis://:%s@cache.example/0",
    canaries["redis_uri"],
)
main.logger.error(
    "amqp-uri-safe-marker amqp://user:%s@mq.example/vhost",
    canaries["amqp_uri"],
)
main.logger.error(
    "encoded-key-safe-marker "
    + r'{"pass\u0077ord": "'
    + canaries["encoded_key"]
    + r'", "safeField": "encoded-json-safe-marker"}'
)
main.logger.error(
    {
        "Signature": canaries["signature_map"],
        "X-Amz-Signature": canaries["amz_signature_map"],
        "auth": ["user", canaries["auth_map"]],
        "authentication": canaries["authentication_map"],
        "safeField": "structured-auth-safe-marker",
    }
)
main.logger.error(
    "unicode-repr-safe-marker Payload: "
    + r"{'pass\u0077ord': '"
    + canaries["unicode_repr"]
    + r"', 'safeField': 'unicode-repr-inner-safe-marker'}"
)
main.logger.info(
    "ordinary-marker-one Using password %s",
    canaries["whitespace_password"],
)
main.logger.info(
    "ordinary-marker-two Using secret %s",
    canaries["whitespace_secret"],
)
main.logger.info(
    "ordinary-marker-three Credential %s",
    canaries["whitespace_credential"],
)
main.logger.info(
    "ordinary-marker-four Authorization %s",
    canaries["whitespace_authorization"],
)
main.logger.info("safe-state-marker PAPERLESS_API_TOKEN: [NOT SET]")
main.logger.info("safe-set-marker PAPERLESS_API_TOKEN: [SET]")
main.logger.info("safe-prose-marker password policy remains enforced")
main.logger.info(
    "header-prose-a-safe-marker authorization policy remains enforced"
)
main.logger.info("header-prose-c-safe-marker cookie policy remains enforced")

idempotent_input = (
    'Idempotent payload: {"password": "'
    + canaries["idempotent"]
    + '", "safeField": "idempotent-safe-marker"}'
)
idempotent_once = main._sanitize_log_text(idempotent_input)
idempotent_twice = main._sanitize_log_text(idempotent_once)
assert idempotent_once == idempotent_twice
main.logger.info("idempotent-pass-safe-marker %s", idempotent_twice)

cyclic_value = {
    "serviceToken": canaries["cycle"],
    "safeField": "cycle-safe-marker",
}
cyclic_value["self"] = cyclic_value
main.logger.error(cyclic_value)

deep_value = {"databasePassword": canaries["deep"]}
for _ in range(1_500):
    deep_value = {"nested": [deep_value]}
main.logger.error(
    {
        "safeField": "deep-safe-marker",
        "payload": deep_value,
    }
)

many_items = {f"safeItem{index}": index for index in range(300)}
many_items["lateSigningKey"] = canaries["late_item"]
main.logger.error(
    {
        "safeField": "item-bound-safe-marker",
        "payload": many_items,
    }
)
main.logger.error(
    "long-text-safe-marker "
    + ("x" * 20_000)
    + f" password={canaries['long']}"
)
long_double_input = (
    "Long double payload: "
    + json.dumps(
        json.dumps(
            {
                "password": canaries["long_double"],
                "safeField": "long-double-json-safe-marker",
                "padding": "x" * 20_000,
            }
        )
    )
)
long_double_output = main._sanitize_log_text(long_double_input)
assert canaries["long_double"] not in long_double_output
assert "[TRUNCATED]" in long_double_output
assert "long-double-json-safe-marker" in long_double_output
main.logger.info("long-double-json-pass-safe-marker")

try:
    raise ValueError(
        f"password={canaries['exception']} exception-detail-safe-marker"
    )
except ValueError:
    main.logger.exception("exception-log-safe-marker")

main.logger.error(
    "stack-safe-marker password=%s",
    canaries["stack"],
    stack_info=True,
)

stack_record = logging.LogRecord(
    "RAGZ",
    logging.ERROR,
    "python_log_sanitizer_check.py",
    1,
    "stack-record-safe-marker",
    (),
    None,
)
stack_record.stack_info = (
    f"password={canaries['stack_text']} stack-detail-safe-marker"
)
main._sensitive_log_filter.filter(stack_record)
print(logging.Formatter("%(message)s").format(stack_record))


class BrokenLogValue:
    def __init__(self, secret):
        self.secret = secret

    def __str__(self):
        raise RuntimeError("intentional log conversion failure")


main.logger.error(BrokenLogValue(canaries["fail_closed"]))

print("python-structured-log-canary-ok")
