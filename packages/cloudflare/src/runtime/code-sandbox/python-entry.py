# Runs in a Python Dynamic Worker: a fresh isolate with no bindings and no network.
# Reuses the stock runner (packages/@n8n/task-runner-python/src). The isolate replaces its subprocess.
import json

from workers import Response, WorkerEntrypoint

from src.config.security_config import SecurityConfig
from src.constants import BUILTINS_DENY_DEFAULT
from src.task_analyzer import TaskAnalyzer
from src.task_executor import TaskExecutor

NODE_MODES = {"runOnceForAllItems": "all_items", "runOnceForEachItem": "per_item"}

outcome = {}


def capture_result(_write_fd, result, print_args):
    outcome["message"] = {"result": result, "print_args": TaskExecutor._truncate_print_args(print_args)}


def capture_error(_write_fd, e, stderr="", print_args=None):
    message = f"Process exited with code {e.code}" if isinstance(e, SystemExit) else str(e)
    outcome["message"] = {
        "error": {"message": message, "description": getattr(e, "description", "") or stderr},
        "print_args": TaskExecutor._truncate_print_args(print_args or []),
    }


class NoPipe:
    def fileno(self):
        return -1


# The executor writes its result to a pipe. Here it stays in this isolate.
TaskExecutor._put_result = staticmethod(capture_result)
TaskExecutor._put_error = staticmethod(capture_error)


def run(settings):
    """Like TaskRunner._execute_task and TaskExecutor.execute_process, without the subprocess."""
    security_config = SecurityConfig(
        stdlib_allow=set(),
        external_allow=set(),
        builtins_deny={name.strip() for name in BUILTINS_DENY_DEFAULT.split(",")},
        runner_env_deny=True,
    )
    try:
        TaskAnalyzer(security_config).validate(settings["code"])
    except SyntaxError as e:
        return {"error": {"message": str(e)}}
    except Exception as e:
        return {"error": {"message": getattr(e, "message", str(e)), "description": getattr(e, "description", "")}}

    execute = TaskExecutor._all_items if NODE_MODES.get(settings["nodeMode"]) == "all_items" else TaskExecutor._per_item
    execute(settings["code"], settings.get("items") or [], NoPipe(), security_config, settings.get("query"))
    message = outcome.get("message", {"error": {"message": "Task result is missing"}})
    if "error" in message and settings.get("continueOnFail"):
        return {"result": [{"json": {"error": message["error"]["message"]}}], "print_args": []}
    if "error" in message:
        return {"error": message["error"]}
    return message


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        settings = json.loads(await request.text())
        return Response(json.dumps(run(settings), default=str, ensure_ascii=False))
