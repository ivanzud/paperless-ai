import io
import logging


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

preconfigured_handler.flush()
late_handler.flush()

output = captured.getvalue() + late_output.getvalue()
assert secret not in output
assert third_party_secret not in output
assert "late-handler-secret-canary" not in output
assert "preconfigured-safe-marker" in output
assert "third-party-httpx-safe-marker" in output
assert "late-handler-safe-marker" in output
assert "[REDACTED]" in output

print(output, end="")
print("python-preconfigured-log-canary-ok")
