import io
import logging

from uvicorn.logging import AccessFormatter


captured = io.StringIO()
preconfigured_handler = logging.StreamHandler(captured)
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

late_output = io.StringIO()
late_handler = logging.StreamHandler(late_output)
late_logger = logging.getLogger("late-third-party")
late_logger.handlers[:] = [late_handler]
late_logger.propagate = False
late_logger.setLevel(logging.INFO)
late_logger.info(
    "late-handler-safe-marker password=%s",
    "late-handler-secret-canary",
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
access_handler.flush()

output = captured.getvalue() + late_output.getvalue() + access_output.getvalue()
assert secret not in output
assert third_party_secret not in output
assert "late-handler-secret-canary" not in output
assert "uvicorn-access-secret-canary" not in output
assert "preconfigured-safe-marker" in output
assert "third-party-httpx-safe-marker" in output
assert "late-handler-safe-marker" in output
assert 'GET /private HTTP/1.1" 200' in output
assert "[REDACTED]" in output

print(output, end="")
print("python-preconfigured-log-canary-ok")
