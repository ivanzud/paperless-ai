import main


captured = {}
startup_handlers_before = list(main.app.router.on_startup)


def fake_uvicorn_runner(served_app, **kwargs):
    captured["app"] = served_app
    captured["kwargs"] = kwargs
    captured["startup_handlers"] = list(served_app.router.on_startup)


main.run_cli(
    [
        "--initialize",
        "--skip-check",
        "--host",
        "127.0.0.1",
        "--port",
        "8123",
    ],
    uvicorn_runner=fake_uvicorn_runner,
)

new_handlers = [
    handler
    for handler in captured["startup_handlers"]
    if handler not in startup_handlers_before
]

assert captured["app"] is main.app
assert captured["kwargs"] == {
    "host": "127.0.0.1",
    "port": 8123,
    "reload": False,
}
assert len(new_handlers) == 1
assert new_handlers[0].__name__ == "initialize_on_startup"

print("cli-app-identity-ok")
