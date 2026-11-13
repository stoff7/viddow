"""Windows 11 process-ownership experiment, deliberately outside run_tool.

Uses only public Win32 APIs. No pipes yet: first prove creation-time ownership,
early-parent-exit, concurrent stop and kill-on-host-exit with harmless children.
"""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import subprocess
import threading
import time

if os.name != "nt":
    raise ImportError("This prototype requires Windows")

SIZE_T = c.c_size_t


class STARTUPINFO(c.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR),
                ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD),
                ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", c.POINTER(c.c_byte)), ("hStdInput", w.HANDLE),
                ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class STARTUPINFOEX(c.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", c.c_void_p)]


class PROCESS_INFORMATION(c.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class BASIC_LIMIT(c.Structure):
    _fields_ = [("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64),
                ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", SIZE_T),
                ("MaximumWorkingSetSize", SIZE_T), ("ActiveProcessLimit", w.DWORD),
                ("Affinity", SIZE_T), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class EXTENDED_LIMIT(c.Structure):
    _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", c.c_uint64 * 6),
                ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T),
                ("PeakProcessMemoryUsed", SIZE_T), ("PeakJobMemoryUsed", SIZE_T)]


class ACCOUNTING(c.Structure):
    _fields_ = [("TotalUserTime", c.c_int64), ("TotalKernelTime", c.c_int64),
                ("ThisPeriodTotalUserTime", c.c_int64), ("ThisPeriodTotalKernelTime", c.c_int64),
                ("TotalPageFaultCount", w.DWORD), ("TotalProcesses", w.DWORD),
                ("ActiveProcesses", w.DWORD), ("TotalTerminatedProcesses", w.DWORD)]


kernel = c.WinDLL("kernel32", use_last_error=True)


def api(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = arguments
    return function


CreateJobObject = api("CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
SetInformationJobObject = api("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
QueryInformationJobObject = api("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
TerminateJobObject = api("TerminateJobObject", w.BOOL, w.HANDLE, w.UINT)
CloseHandle = api("CloseHandle", w.BOOL, w.HANDLE)
InitializeAttributes = api("InitializeProcThreadAttributeList", w.BOOL, c.c_void_p, w.DWORD, w.DWORD, c.POINTER(SIZE_T))
UpdateAttribute = api("UpdateProcThreadAttribute", w.BOOL, c.c_void_p, w.DWORD, SIZE_T, c.c_void_p, SIZE_T, c.c_void_p, c.c_void_p)
DeleteAttributes = api("DeleteProcThreadAttributeList", None, c.c_void_p)
CreateProcess = api("CreateProcessW", w.BOOL, w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p,
                    w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(STARTUPINFOEX), c.POINTER(PROCESS_INFORMATION))
WaitForSingleObject = api("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
GetExitCodeProcess = api("GetExitCodeProcess", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))


def checked(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result


class JobProcess:
    """One non-inheritable job per tree; stop waits for the job, not just its root.

    No breakaway and no fallback to an unowned process on assignment failure.
    Call stop in finally even after wait() reports that the root has exited.
    """

    def __init__(self, argv, *, cancel=None):
        self._lock = threading.Lock()
        self._job = None
        self._process = None
        self.pid = None
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Cancelled before process creation")
        executable = Path(argv[0])
        if not executable.is_absolute() or not executable.is_file() or executable.suffix.lower() != ".exe":
            raise ValueError("Prototype requires an absolute executable .exe path")
        job = checked(CreateJobObject(None, None))
        self._job = job
        attributes = None
        initialized = False
        try:
            limits = EXTENDED_LIMIT()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
            checked(SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
            size = SIZE_T()
            InitializeAttributes(None, 1, 0, c.byref(size))
            if not size.value or c.get_last_error() != 122:  # ERROR_INSUFFICIENT_BUFFER
                raise c.WinError(c.get_last_error())
            attributes = c.create_string_buffer(size.value)
            checked(InitializeAttributes(attributes, 1, 0, c.byref(size)))
            initialized = True
            jobs = (w.HANDLE * 1)(job)
            checked(UpdateAttribute(attributes, 0, 0x0002000D, jobs, c.sizeof(jobs), None, None))
            startup = STARTUPINFOEX()
            startup.StartupInfo.cb = c.sizeof(startup)
            startup.lpAttributeList = c.cast(attributes, c.c_void_p)
            process = PROCESS_INFORMATION()
            command = c.create_unicode_buffer(subprocess.list2cmdline([str(item) for item in argv]))
            checked(CreateProcess(str(executable), command, None, None, False,
                                  0x00080000 | 0x08000000,  # EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
                                  None, None, c.byref(startup), c.byref(process)))
            self._process = process.hProcess
            self.pid = process.dwProcessId
            checked(CloseHandle(process.hThread))
            if cancel is not None and cancel.is_set():
                self.stop()
                raise InterruptedError("Cancelled during process creation")
        except BaseException:
            self.stop()
            raise
        finally:
            if initialized:
                DeleteAttributes(attributes)

    def wait(self, timeout=5):
        # Prototype callers wait before racing stop(); closed handles are never
        # passed to WinAPI. The shared lock bounds that race by the timeout.
        with self._lock:
            if self._process is None:
                raise ValueError("Process owner is closed")
            result = WaitForSingleObject(self._process, int(timeout * 1000))
            if result == 258:
                raise subprocess.TimeoutExpired(str(self.pid), timeout)
            if result != 0:
                raise c.WinError(c.get_last_error())
            code = w.DWORD()
            checked(GetExitCodeProcess(self._process, c.byref(code)))
            return code.value

    def stop(self, timeout=5):
        with self._lock:
            if self._job is None:
                return
            checked(TerminateJobObject(self._job, 1))
            deadline = time.monotonic() + timeout
            while True:
                info = ACCOUNTING()
                checked(QueryInformationJobObject(self._job, 1, c.byref(info), c.sizeof(info), None))
                if not info.ActiveProcesses:
                    break
                if time.monotonic() >= deadline:
                    # Keep ownership for retry; don't claim temp cleanup is safe.
                    raise TimeoutError("Job still contains live processes")
                time.sleep(0.01)
            if self._process is not None:
                checked(CloseHandle(self._process))
                self._process = None
            checked(CloseHandle(self._job))
            self._job = None
