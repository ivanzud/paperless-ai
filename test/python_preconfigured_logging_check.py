import io
import logging

from uvicorn.logging import AccessFormatter


captured = io.StringIO()
preconfigured_handler = logging.StreamHandler(captured)
extra_defaults = {
    "secret_extra": "-",
    "url_extra": "-",
    "safe_number": 0,
    "nested_extra": "-",
    "cyclic_extra": "-",
}
extra_formatter = logging.Formatter(
    (
        "%(message)s | secret=%(secret_extra)s | url=%(url_extra)s "
        "| number=%(safe_number)d | nested=%(nested_extra)s "
        "| cycle=%(cyclic_extra)s | path=%(pathname)s"
    ),
    defaults=extra_defaults,
)
preconfigured_handler.setFormatter(extra_formatter)
root_logger = logging.getLogger()
root_logger.handlers[:] = [preconfigured_handler]
root_logger.setLevel(logging.INFO)

import main


secret = "preconfigured-root-secret-canary"
main.logger.error(
    "preconfigured-safe-marker password=%s",
    secret,
)

third_party_secret = "hf-signature-secret-canary"
hf_signed_url = (
    "https://us.aws.cdn.hf.co/xet-bridge-us/model.safetensors"
    "?Expires=1785481726"
    "&Policy=public-policy"
    f"&Signature={third_party_secret}"
    "&Key-Pair-Id=public-key-id"
)
logging.getLogger("httpx").info(
    'third-party-httpx-safe-marker HTTP Request: GET %s "HTTP/1.1 200 OK"',
    hf_signed_url,
)

preconfigured_cycle = {
    "safeField": "preconfigured-cycle-safe-marker",
    "password": "preconfigured-cycle-secret-canary",
}
preconfigured_cycle["self"] = preconfigured_cycle
logging.getLogger("preconfigured-extra").info(
    "preconfigured-extra-safe-marker",
    extra={
        "secret_extra": "preconfigured-extra-secret-canary",
        "url_extra": (
            "postgresql://user:preconfigured-extra-url-canary"
            "@db.example/app"
        ),
        "safe_number": 42,
        "nested_extra": {
            "serviceToken": "preconfigured-nested-secret-canary",
            "safeField": "preconfigured-nested-safe-marker",
        },
        "cyclic_extra": preconfigured_cycle,
    },
)

late_output = io.StringIO()
late_handler = logging.StreamHandler(late_output)
late_handler.setFormatter(extra_formatter)


class LateExtraFilter(logging.Filter):
    def filter(self, record):
        record.secret_extra = "late-filter-extra-secret-canary"
        record.url_extra = (
            "redis://:late-filter-url-secret-canary@cache.example/0"
        )
        record.safe_number = 84
        record.nested_extra = {
            "sessionCookie": "late-filter-nested-secret-canary",
            "safeField": "late-filter-nested-safe-marker",
        }
        record.cyclic_extra = {"safeField": "late-filter-cycle-safe-marker"}
        return True


late_handler.addFilter(LateExtraFilter())
late_logger = logging.getLogger("late-third-party")
late_logger.handlers[:] = [late_handler]
late_logger.propagate = False
late_logger.setLevel(logging.INFO)
late_logger.info(
    "late-handler-safe-marker password=%s",
    "late-handler-secret-canary",
)

record_output = io.StringIO()
record_handler = logging.StreamHandler(record_output)
record_handler.setFormatter(extra_formatter)
record_logger = logging.getLogger("remote-record")
record_logger.handlers[:] = [record_handler]
record_logger.propagate = False
record_logger.setLevel(logging.INFO)

remote_record = logging.makeLogRecord(
    {
        "name": "remote-record",
        "levelno": logging.ERROR,
        "levelname": "ERROR",
        "pathname": (
            "postgresql://user:make-record-path-secret-canary"
            "@db.example/app"
        ),
        "msg": "make-record-safe-marker password=make-record-message-secret-canary",
        "args": (),
        "secret_extra": "make-record-extra-secret-canary",
        "url_extra": (
            "amqp://user:make-record-url-secret-canary@mq.example/vhost"
        ),
        "safe_number": 126,
        "nested_extra": {
            "apiKey": "make-record-nested-secret-canary",
            "safeField": "make-record-nested-safe-marker",
        },
        "cyclic_extra": {"safeField": "make-record-cycle-safe-marker"},
    }
)
record_logger.handle(remote_record)

direct_record = logging.LogRecord(
    "direct-record",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "direct-record-safe-marker password=direct-record-message-secret-canary",
    (),
    None,
)
direct_record.secret_extra = "direct-record-extra-secret-canary"
direct_record.url_extra = (
    "mysql://user:direct-record-url-secret-canary@db.example/app"
)
direct_record.safe_number = 168
direct_record.nested_extra = {
    "credential": "direct-record-nested-secret-canary",
    "safeField": "direct-record-nested-safe-marker",
}
direct_record.cyclic_extra = {"safeField": "direct-record-cycle-safe-marker"}
record_handler.handle(direct_record)


class BrokenExtraValue:
    def __init__(self, secret):
        self.secret = secret

    def __str__(self):
        raise RuntimeError("intentional extra conversion failure")


fail_closed_output = io.StringIO()
fail_closed_handler = logging.StreamHandler(fail_closed_output)
fail_closed_handler.setFormatter(
    logging.Formatter(
        (
            "%(message)s %(opaque_extra)s number=%(safe_number)d "
            "ratio=%(safe_ratio).2f enabled=%(safe_enabled)s"
        ),
        defaults={
            "opaque_extra": "-",
            "safe_number": 0,
            "safe_ratio": 0.0,
            "safe_enabled": False,
        },
    )
)
fail_closed_record = logging.LogRecord(
    "fail-closed-extra",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "fail-closed-extra-safe-marker",
    (),
    None,
)
fail_closed_record.opaque_extra = BrokenExtraValue(
    "fail-closed-extra-secret-canary"
)
fail_closed_record.safe_number = 210
fail_closed_record.safe_ratio = 0.75
fail_closed_record.safe_enabled = True
fail_closed_handler.handle(fail_closed_record)

access_output = io.StringIO()
access_handler = logging.StreamHandler(access_output)
access_handler.setFormatter(
    AccessFormatter(
        '%(client_addr)s - "%(request_line)s" %(status_code)s',
        use_colors=False,
    )
)
access_logger = logging.getLogger("uvicorn.access")
access_logger.handlers[:] = [access_handler]
access_logger.propagate = False
access_logger.setLevel(logging.INFO)
access_logger.info(
    '%s - "%s %s HTTP/%s" %d',
    "127.0.0.1:12345",
    "GET",
    "/private?token=uvicorn-access-secret-canary",
    "1.1",
    200,
)

preconfigured_handler.flush()
late_handler.flush()
record_handler.flush()
fail_closed_handler.flush()
access_handler.flush()

output = (
    captured.getvalue()
    + late_output.getvalue()
    + record_output.getvalue()
    + fail_closed_output.getvalue()
    + access_output.getvalue()
)
assert secret not in output
assert third_party_secret not in output
assert "late-handler-secret-canary" not in output
assert "uvicorn-access-secret-canary" not in output
for extra_secret in (
    "preconfigured-extra-secret-canary",
    "preconfigured-extra-url-canary",
    "preconfigured-nested-secret-canary",
    "preconfigured-cycle-secret-canary",
    "late-filter-extra-secret-canary",
    "late-filter-url-secret-canary",
    "late-filter-nested-secret-canary",
    "make-record-message-secret-canary",
    "make-record-extra-secret-canary",
    "make-record-url-secret-canary",
    "make-record-path-secret-canary",
    "make-record-nested-secret-canary",
    "direct-record-message-secret-canary",
    "direct-record-extra-secret-canary",
    "direct-record-url-secret-canary",
    "direct-record-nested-secret-canary",
    "fail-closed-extra-secret-canary",
):
    assert extra_secret not in output
assert "preconfigured-safe-marker" in output
assert "third-party-httpx-safe-marker" in output
assert "late-handler-safe-marker" in output
assert "preconfigured-extra-safe-marker" in output
assert "preconfigured-nested-safe-marker" in output
assert "preconfigured-cycle-safe-marker" in output
assert "late-filter-nested-safe-marker" in output
assert "make-record-safe-marker" in output
assert "make-record-nested-safe-marker" in output
assert "direct-record-safe-marker" in output
assert "direct-record-nested-safe-marker" in output
assert "[log sanitization failed]" in output
for safe_number in ("42", "84", "126", "168", "210"):
    assert f"number={safe_number}" in output
assert "ratio=0.75 enabled=True" in output
assert 'GET /private HTTP/1.1" 200' in output
assert "[REDACTED]" in output

print(output, end="")
print("python-preconfigured-log-canary-ok")
