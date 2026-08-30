"""在独立受限进程中执行已经通过 AST 校验的核算规则。"""

from __future__ import annotations

import multiprocessing
import pickle
from typing import Any

from .safe_python import SAFE_BUILTINS, SAFE_GLOBALS, validate_rule_code


RULE_TIMEOUT_SECONDS = 2.0
MAX_RULE_CODE_LENGTH = 100_000
MAX_IPC_PAYLOAD_BYTES = 8 * 1024 * 1024


def _apply_resource_limits() -> None:
    """为规则 worker 设置操作系统级资源上限；不支持的平台自动跳过对应项。"""
    try:
        import resource
    except ImportError:
        return

    limits = (
        ("RLIMIT_CPU", 2, 3),
        ("RLIMIT_AS", 512 * 1024 * 1024, 512 * 1024 * 1024),
        ("RLIMIT_FSIZE", 8 * 1024 * 1024, 8 * 1024 * 1024),
        ("RLIMIT_NOFILE", 32, 32),
    )
    for limit_name, soft, hard in limits:
        limit = getattr(resource, limit_name, None)
        if limit is None:
            continue
        try:
            current_soft, current_hard = resource.getrlimit(limit)
            bounded_hard = hard if current_hard == resource.RLIM_INFINITY else min(hard, current_hard)
            bounded_soft = min(soft, bounded_hard)
            resource.setrlimit(limit, (bounded_soft, bounded_hard))
        except (OSError, ValueError):
            # macOS、容器或受限运行环境可能不允许调整某一项；其他限制仍然生效。
            continue


def _execute_rule(code: str, source: dict[str, Any], result: dict[str, Any], rule_label: str) -> dict[str, Any] | None:
    tree, entry_function_name = validate_rule_code(code, rule_label)
    namespace: dict[str, Any] = {**SAFE_GLOBALS, "__builtins__": SAFE_BUILTINS}
    # 这里的 exec 只存在于独立 worker 进程中，主服务进程不会执行用户/配置代码。
    exec(compile(tree, "<approved-calculation-rule-worker>", "exec"), namespace, namespace)
    function = namespace[entry_function_name]
    try:
        value = function(rows=source, context=result)
    except TypeError:
        try:
            value = function(source, result)
        except Exception as exc:
            raise ValueError(f"规则“{rule_label}”执行失败：{type(exc).__name__}: {exc}") from exc
    except Exception as exc:
        raise ValueError(f"规则“{rule_label}”执行失败：第一个员工数据行触发 {type(exc).__name__}: {exc}") from exc
    return value if isinstance(value, dict) else None


def _send_response(connection: Any, response: dict[str, Any]) -> None:
    if len(pickle.dumps(response, protocol=pickle.HIGHEST_PROTOCOL)) > MAX_IPC_PAYLOAD_BYTES:
        connection.send({"ok": False, "error": "规则返回结果超过允许大小"})
        return
    connection.send(response)


def _worker_main(connection: Any) -> None:
    _apply_resource_limits()
    try:
        while True:
            request = connection.recv()
            if request == "shutdown":
                return
            code, source, result, rule_label = request
            try:
                value = _execute_rule(code, source, result, rule_label)
                _send_response(connection, {"ok": True, "value": value})
            except Exception as exc:
                _send_response(connection, {"ok": False, "error": str(exc)})
    except (EOFError, OSError):
        return
    finally:
        connection.close()


class RuleExecutionSandbox:
    """复用一个受限 worker，逐条规则调用并对每次调用执行超时控制。"""

    def __init__(self, timeout_seconds: float = RULE_TIMEOUT_SECONDS) -> None:
        self.timeout_seconds = timeout_seconds
        self._context = multiprocessing.get_context("spawn")
        self._process: multiprocessing.Process | None = None
        self._connection: Any = None

    def __enter__(self) -> "RuleExecutionSandbox":
        return self

    def __exit__(self, _exc_type: Any, _exc_value: Any, _traceback: Any) -> None:
        self.close()

    def _start(self) -> None:
        parent_connection, child_connection = self._context.Pipe()
        process = self._context.Process(target=_worker_main, args=(child_connection,), name="payroll-rule-worker")
        process.daemon = True
        process.start()
        child_connection.close()
        self._connection = parent_connection
        self._process = process

    def _stop(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except OSError:
                pass
        if self._process is not None:
            self._process.terminate()
            self._process.join(timeout=0.5)
            if self._process.is_alive() and hasattr(self._process, "kill"):
                self._process.kill()
                self._process.join(timeout=0.5)
        self._connection = None
        self._process = None

    def execute(self, code: str, source: dict[str, Any], result: dict[str, Any], rule_label: str) -> dict[str, Any] | None:
        normalized_code = str(code or "")
        if len(normalized_code) > MAX_RULE_CODE_LENGTH:
            raise ValueError(f"规则“{rule_label}”代码超过 {MAX_RULE_CODE_LENGTH} 个字符")
        request = (normalized_code, source, result, str(rule_label or "未命名规则"))
        if len(pickle.dumps(request, protocol=pickle.HIGHEST_PROTOCOL)) > MAX_IPC_PAYLOAD_BYTES:
            raise ValueError(f"规则“{rule_label}”执行数据超过允许大小")
        if self._process is None or not self._process.is_alive() or self._connection is None:
            self._start()
        try:
            self._connection.send(request)
            if not self._connection.poll(self.timeout_seconds):
                self._stop()
                raise ValueError(f"规则“{rule_label}”执行超时（超过 {self.timeout_seconds:g} 秒），已终止隔离进程")
            response = self._connection.recv()
        except (EOFError, OSError, BrokenPipeError) as exc:
            self._stop()
            raise ValueError(f"规则“{rule_label}”执行进程异常终止") from exc
        if not isinstance(response, dict) or not response.get("ok"):
            raise ValueError(str(response.get("error") if isinstance(response, dict) else "规则执行失败"))
        return response.get("value")

    def close(self) -> None:
        if self._process is None:
            return
        if self._connection is not None and self._process.is_alive():
            try:
                self._connection.send("shutdown")
            except (OSError, BrokenPipeError):
                pass
        if self._process is not None:
            self._process.join(timeout=0.5)
        if self._process is not None and self._process.is_alive():
            self._stop()
        else:
            if self._connection is not None:
                self._connection.close()
            self._connection = None
            self._process = None
