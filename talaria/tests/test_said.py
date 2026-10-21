import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("talaria_plugin_under_test", Path(__file__).parents[1] / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)


def test_a_write_and_a_run_say_what_happened():
    assert plugin._said("write", "anubis", {"path": "C:/x/hi.txt", "written": True}) == {
        "done": "Done: C:/x/hi.txt is written on anubis. Nothing more is needed."}
    ok = plugin._said("run", "anubis", {"exit_code": 0, "output": "", "timed_out": False})["done"]
    assert "exit code 0 (success)" in ok and "does not need running again" in ok
    assert "exit code 3 (an error)" in plugin._said("run", "anubis", {"exit_code": 3, "timed_out": False})["done"]
    assert "time ran out" in plugin._said("run", "anubis", {"exit_code": None, "timed_out": True})["done"]
    assert plugin._said("read", "anubis", {"text": "hi"}) == {} and plugin._said("run", "anubis", "odd") == {}
