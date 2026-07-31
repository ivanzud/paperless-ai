import importlib
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


class PreexistingOverrideHandler(logging.Handler):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def handle(self, record):
        self.stream.write(
            f"{record.getMessage()} | override={record.override_extra}\n"
        )
        return True


class OverrideMutationFilter(logging.Filter):
    def __init__(self, prefix):
        super().__init__()
        self.prefix = prefix

    def filter(self, record):
        record.msg = (
            f"{self.prefix}-filter-safe-marker "
            f"password={self.prefix}-filter-message-secret-canary"
        )
        record.args = ()
        record.override_extra = (
            f"token={self.prefix}-filter-extra-secret-canary"
        )
        return True


class PreexistingFilteredOverrideHandler(logging.Handler):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def handle(self, record):
        filtered_record = self.filter(record)
        if isinstance(filtered_record, logging.LogRecord):
            record = filtered_record
        if filtered_record:
            self.stream.write(
                f"{record.getMessage()} | override={record.override_extra}\n"
            )
        return filtered_record


preexisting_override_output = io.StringIO()
preexisting_override_handler = PreexistingOverrideHandler(
    preexisting_override_output
)
preexisting_filtered_override_output = io.StringIO()
preexisting_filtered_override_handler = PreexistingFilteredOverrideHandler(
    preexisting_filtered_override_output
)
preexisting_filtered_override_handler.addFilter(
    OverrideMutationFilter("preexisting-override")
)
root_logger = logging.getLogger()
root_logger.handlers[:] = [preconfigured_handler]
root_logger.setLevel(logging.INFO)

import main


class FutureOverrideHandler(logging.Handler):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def handle(self, record):
        self.stream.write(
            f"{record.getMessage()} | override={record.override_extra}\n"
        )
        return True


class FutureFilteredOverrideHandler(logging.Handler):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def handle(self, record):
        filtered_record = self.filter(record)
        if isinstance(filtered_record, logging.LogRecord):
            record = filtered_record
        if filtered_record:
            self.stream.write(
                f"{record.getMessage()} | override={record.override_extra}\n"
            )
        return filtered_record


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

override_logger = logging.getLogger("override-handler")
override_logger.handlers[:] = [preexisting_override_handler]
override_logger.propagate = False
override_logger.setLevel(logging.INFO)
override_logger.info(
    "preexisting-override-safe-marker password=%s",
    "preexisting-override-message-secret-canary",
    extra={
        "override_extra": (
            "postgresql://user:preexisting-override-extra-secret-canary"
            "@db.example/app"
        )
    },
)

future_override_output = io.StringIO()
future_override_handler = FutureOverrideHandler(future_override_output)
future_override_record = logging.LogRecord(
    "future-override-handler",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "future-override-safe-marker password=future-override-message-secret-canary",
    (),
    None,
)
future_override_record.override_extra = (
    "redis://:future-override-extra-secret-canary@cache.example/0"
)
future_override_handler.handle(future_override_record)

preexisting_filtered_logger = logging.getLogger(
    "preexisting-filtered-override-handler"
)
preexisting_filtered_logger.handlers[:] = [
    preexisting_filtered_override_handler
]
preexisting_filtered_logger.propagate = False
preexisting_filtered_logger.setLevel(logging.INFO)
preexisting_filtered_logger.info(
    "preexisting-filtered-input-safe-marker",
    extra={"override_extra": "preexisting-filtered-input-extra"},
)

future_filtered_override_output = io.StringIO()
future_filtered_override_handler = FutureFilteredOverrideHandler(
    future_filtered_override_output
)
future_filtered_override_handler.addFilter(
    OverrideMutationFilter("future-override")
)
future_filtered_override_record = logging.LogRecord(
    "future-filtered-override-handler",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "future-filtered-input-safe-marker",
    (),
    None,
)
future_filtered_override_record.override_extra = (
    "future-filtered-input-extra"
)
future_filtered_override_handler.handle(future_filtered_override_record)

late_assigned_override_output = io.StringIO()
late_assigned_override_handler = FutureFilteredOverrideHandler(
    late_assigned_override_output
)
late_assigned_override_handler.filter = OverrideMutationFilter(
    "late-assigned-override"
).filter
late_assigned_override_record = logging.LogRecord(
    "late-assigned-override-handler",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "late-assigned-input-safe-marker",
    (),
    None,
)
late_assigned_override_record.override_extra = "late-assigned-input-extra"
late_assigned_override_handler.handle(late_assigned_override_record)


class SuperFilteredOverrideHandler(logging.Handler):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def handle(self, record):
        filtered_record = super().filter(record)
        if isinstance(filtered_record, logging.LogRecord):
            record = filtered_record
        if filtered_record:
            self.stream.write(
                f"{record.getMessage()} | override={record.override_extra}\n"
            )
        return filtered_record


super_filtered_override_output = io.StringIO()
super_filtered_override_handler = SuperFilteredOverrideHandler(
    super_filtered_override_output
)
super_filtered_override_handler.addFilter(
    OverrideMutationFilter("super-filtered-override")
)
super_filtered_override_record = logging.LogRecord(
    "super-filtered-override-handler",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "super-filtered-input-safe-marker",
    (),
    None,
)
super_filtered_override_record.override_extra = "super-filtered-input-extra"
super_filtered_override_handler.handle(super_filtered_override_record)


class PostFilterEmitHandler(logging.StreamHandler):
    def handle(self, record):
        filtered_record = self.filter(record)
        if isinstance(filtered_record, logging.LogRecord):
            record = filtered_record
        if filtered_record:
            record.msg = (
                "post-filter-emit-safe-marker "
                "password=post-filter-emit-message-secret-canary"
            )
            record.args = ()
            record.secret_extra = "post-filter-emit-extra-secret-canary"
            self.emit(record)
        return filtered_record


post_filter_emit_output = io.StringIO()
post_filter_emit_handler = PostFilterEmitHandler(post_filter_emit_output)
post_filter_emit_handler.setFormatter(
    logging.Formatter("%(message)s | extra=%(secret_extra)s")
)
post_filter_emit_record = logging.LogRecord(
    "post-filter-emit-handler",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "post-filter-input-safe-marker",
    (),
    None,
)
post_filter_emit_record.secret_extra = "post-filter-input-extra"
post_filter_emit_handler.handle(post_filter_emit_record)


class ReplacementRecordFilter(logging.Filter):
    def filter(self, record):
        replacement = logging.LogRecord(
            "replacement-record-handler",
            logging.ERROR,
            "python_preconfigured_logging_check.py",
            1,
            (
                "replacement-record-safe-marker "
                "password=replacement-record-message-secret-canary"
            ),
            (),
            None,
        )
        replacement.secret_extra = (
            "token=replacement-record-extra-secret-canary"
        )
        return replacement


replacement_record_output = io.StringIO()
replacement_record_handler = logging.StreamHandler(replacement_record_output)
replacement_record_handler.setFormatter(
    logging.Formatter("%(message)s | extra=%(secret_extra)s")
)
replacement_record_handler.addFilter(ReplacementRecordFilter())
replacement_record = logging.LogRecord(
    "replacement-record-input",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "replacement-record-input-safe-marker",
    (),
    None,
)
replacement_record_handler.handle(replacement_record)


class BrokenExtraKey:
    def __hash__(self):
        return 31_337

    def __str__(self):
        raise RuntimeError("intentional extra key conversion failure")


malformed_key_output = io.StringIO()
malformed_key_handler = logging.StreamHandler(malformed_key_output)
malformed_key_handler.setFormatter(logging.Formatter("%(message)s"))
malformed_key_record = logging.LogRecord(
    "malformed-extra-key",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "malformed-key-safe-marker",
    (),
    None,
)
malformed_key_record.__dict__[BrokenExtraKey()] = (
    "malformed-key-secret-canary"
)
malformed_key_handler.handle(malformed_key_record)

remote_core_output = io.StringIO()
remote_core_handler = logging.StreamHandler(remote_core_output)
remote_core_handler.setFormatter(
    logging.Formatter("%(message)s process=%(process)s thread=%(thread)s")
)
remote_core_record = logging.makeLogRecord(
    {
        "name": "remote-core-fields",
        "levelno": logging.ERROR,
        "levelname": "ERROR",
        "msg": "remote-core-safe-marker",
        "args": (),
        "process": "password=remote-process-secret-canary",
        "thread": (
            "postgresql://user:remote-thread-secret-canary@db.example/app"
        ),
    }
)
remote_core_handler.handle(remote_core_record)


class CoreSecretObject:
    def __str__(self):
        return "password=core-created-object-secret-canary"


opaque_core_output = io.StringIO()
opaque_core_handler = logging.StreamHandler(opaque_core_output)
opaque_core_handler.setFormatter(
    logging.Formatter(
        (
            "%(message)s process=%(process)d thread=%(thread)d "
            "line=%(lineno)d created=%(created).1f"
        )
    )
)
opaque_core_record = logging.makeLogRecord(
    {
        "name": "opaque-core-fields",
        "levelno": logging.ERROR,
        "levelname": "ERROR",
        "msg": "opaque-core-safe-marker",
        "args": (),
        "process": b"password=core-process-bytes-secret-canary",
        "thread": {"password": "core-thread-map-secret-canary"},
        "lineno": ["password=core-line-list-secret-canary"],
        "created": CoreSecretObject(),
    }
)
opaque_core_handler.handle(opaque_core_record)

malformed_level_output = io.StringIO()
malformed_level_handler = logging.StreamHandler(malformed_level_output)
malformed_level_handler.setFormatter(
    logging.Formatter("%(message)s level=%(levelno)d")
)
malformed_level_logger = logging.getLogger("malformed-level-record")
malformed_level_logger.handlers[:] = [malformed_level_handler]
malformed_level_logger.propagate = False
malformed_level_record = logging.makeLogRecord(
    {
        "name": "malformed-level-record",
        "levelno": "password=core-level-secret-canary",
        "levelname": "ERROR",
        "msg": "malformed-level-safe-marker",
        "args": (),
    }
)
malformed_level_logger.handle(malformed_level_record)

numeric_sensitive_output = io.StringIO()
numeric_sensitive_handler = logging.StreamHandler(numeric_sensitive_output)
numeric_sensitive_handler.setFormatter(
    logging.Formatter("%(message)s key=%(apiKey)d")
)
numeric_sensitive_record = logging.LogRecord(
    "numeric-sensitive-extra",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "numeric-sensitive-safe-marker",
    (),
    None,
)
numeric_sensitive_record.apiKey = 123456
numeric_sensitive_handler.handle(numeric_sensitive_record)


class FalseyExceptionInfo:
    def __bool__(self):
        return False

    def __str__(self):
        return "password=falsey-exc-info-secret-canary"


falsey_exc_output = io.StringIO()
falsey_exc_handler = logging.StreamHandler(falsey_exc_output)
falsey_exc_handler.setFormatter(
    logging.Formatter("%(message)s exc=%(exc_info)s")
)
falsey_exc_record = logging.LogRecord(
    "falsey-exception-info",
    logging.ERROR,
    "python_preconfigured_logging_check.py",
    1,
    "falsey-exc-info-safe-marker",
    (),
    None,
)
falsey_exc_record.exc_info = FalseyExceptionInfo()
falsey_exc_handler.handle(falsey_exc_record)

extreme_numeric_output = io.StringIO()
extreme_numeric_handler = logging.StreamHandler(extreme_numeric_output)
extreme_numeric_handler.setFormatter(
    logging.Formatter(
        (
            "%(message)s level=%(levelno)d process=%(process)d "
            "thread=%(thread)d line=%(lineno)d created=%(created).1f "
            "msecs=%(msecs).1f relative=%(relativeCreated).1f "
            "asctime=%(asctime)s"
        )
    )
)
extreme_numeric_record = logging.makeLogRecord(
    {
        "name": "extreme-numeric-core-fields",
        "levelno": 10**5_000,
        "levelname": "ERROR",
        "msg": "extreme-numeric-safe-marker",
        "args": (),
        "process": 10**5_000,
        "thread": -(10**5_000),
        "lineno": 10**5_000,
        "created": float("inf"),
        "msecs": float("nan"),
        "relativeCreated": float("-inf"),
    }
)
extreme_numeric_handler.handle(extreme_numeric_record)

for _ in range(6):
    main = importlib.reload(main)
root_filter_count = sum(
    bool(getattr(item, "_paperless_ai_sensitive_filter", False))
    for item in preconfigured_handler.filters
)
logger_filter_count = sum(
    bool(getattr(item, "_paperless_ai_sensitive_filter", False))
    for item in main.logger.filters
)
assert root_filter_count == 1
assert logger_filter_count == 1
reload_output = io.StringIO()
reload_output.write(
    (
        "reload-filter-count-safe-marker "
        f"root={root_filter_count} logger={logger_filter_count}\n"
    )
)
reload_handler = logging.StreamHandler(reload_output)
reload_handler.setFormatter(logging.Formatter("%(message)s"))
reload_logger = logging.getLogger("reload-safe-logger")
reload_logger.handlers[:] = [reload_handler]
reload_logger.propagate = False
reload_logger.setLevel(logging.INFO)
reload_logger.info(
    "reload-safe-marker password=%s",
    "reload-hook-secret-canary",
)

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
    + preexisting_override_output.getvalue()
    + future_override_output.getvalue()
    + preexisting_filtered_override_output.getvalue()
    + future_filtered_override_output.getvalue()
    + late_assigned_override_output.getvalue()
    + super_filtered_override_output.getvalue()
    + post_filter_emit_output.getvalue()
    + replacement_record_output.getvalue()
    + malformed_key_output.getvalue()
    + remote_core_output.getvalue()
    + opaque_core_output.getvalue()
    + malformed_level_output.getvalue()
    + numeric_sensitive_output.getvalue()
    + falsey_exc_output.getvalue()
    + extreme_numeric_output.getvalue()
    + reload_output.getvalue()
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
    "preexisting-override-message-secret-canary",
    "preexisting-override-extra-secret-canary",
    "future-override-message-secret-canary",
    "future-override-extra-secret-canary",
    "preexisting-override-filter-message-secret-canary",
    "preexisting-override-filter-extra-secret-canary",
    "future-override-filter-message-secret-canary",
    "future-override-filter-extra-secret-canary",
    "late-assigned-override-filter-message-secret-canary",
    "late-assigned-override-filter-extra-secret-canary",
    "super-filtered-override-filter-message-secret-canary",
    "super-filtered-override-filter-extra-secret-canary",
    "post-filter-emit-message-secret-canary",
    "post-filter-emit-extra-secret-canary",
    "replacement-record-message-secret-canary",
    "replacement-record-extra-secret-canary",
    "malformed-key-secret-canary",
    "remote-process-secret-canary",
    "remote-thread-secret-canary",
    "core-process-bytes-secret-canary",
    "core-thread-map-secret-canary",
    "core-line-list-secret-canary",
    "core-created-object-secret-canary",
    "core-level-secret-canary",
    "falsey-exc-info-secret-canary",
    "reload-hook-secret-canary",
    "123456",
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
assert "preexisting-override-safe-marker" in output
assert "future-override-safe-marker" in output
assert "preexisting-override-filter-safe-marker" in output
assert "future-override-filter-safe-marker" in output
assert "late-assigned-override-filter-safe-marker" in output
assert "super-filtered-override-filter-safe-marker" in output
assert "post-filter-emit-safe-marker" in output
assert "replacement-record-safe-marker" in output
assert "remote-core-safe-marker" in output
assert (
    "opaque-core-safe-marker process=0 thread=0 line=0 created=0.0"
    in output
)
assert "malformed-level-safe-marker level=0" in output
assert "numeric-sensitive-safe-marker key=0" in output
assert "falsey-exc-info-safe-marker exc=None" in output
assert (
    "extreme-numeric-safe-marker level=0 process=0 thread=0 line=0 "
    "created=0.0 msecs=0.0 relative=0.0"
    in output
)
assert "reload-filter-count-safe-marker root=1 logger=1" in output
assert "reload-safe-marker" in output
assert "[log sanitization failed]" in output
assert "[log sanitization failed]" in malformed_key_output.getvalue()
for safe_number in ("42", "84", "126", "168", "210"):
    assert f"number={safe_number}" in output
assert "ratio=0.75 enabled=True" in output
assert 'GET /private HTTP/1.1" 200' in output
assert "[REDACTED]" in output

print(output, end="")
print("python-preconfigured-log-canary-ok")
