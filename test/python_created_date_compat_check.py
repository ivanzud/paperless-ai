import main


canonical = "2026-08-31"
legacy = "2026-08-30"

assert main._get_document_created({"created": canonical}) == canonical
assert main._get_document_created({"created_date": legacy}) == legacy
assert main._get_document_created(
    {"created": canonical, "created_date": legacy}
) == canonical

print("python-created-date-compat-ok")
