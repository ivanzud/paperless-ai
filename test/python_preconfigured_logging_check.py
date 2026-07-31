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
preconfigured_handler.flush()

output = captured.getvalue()
assert secret not in output
assert "preconfigured-safe-marker" in output
assert "[REDACTED]" in output

print(output, end="")
print("python-preconfigured-log-canary-ok")
