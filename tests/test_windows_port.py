import io
import json
import struct
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from native_protocol import MAX_MESSAGE_BYTES, read_message
from windows_native_install import launcher_text, validate_extension_ids
import windows_native_install


class RegistryKey:
    def __init__(self, values):
        self.values = values
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


class Registry:
    HKEY_CURRENT_USER = 1
    KEY_READ = 2
    KEY_SET_VALUE = 4
    KEY_WOW64_32KEY = 8

    def __init__(self):
        self.keys = {}
    def OpenKey(self, hive, path, reserved, access):
        if path not in self.keys:
            raise FileNotFoundError(path)
        return RegistryKey(self.keys[path])
    def CreateKeyEx(self, hive, path, reserved, access):
        return RegistryKey(self.keys.setdefault(path, {}))
    def QueryValueEx(self, key, name):
        if name not in key.values:
            raise FileNotFoundError(name)
        return key.values[name], self.REG_SZ
    def SetValueEx(self, key, name, reserved, kind, value):
        key.values[name] = value
    def DeleteValue(self, key, name):
        del key.values[name]
    def QueryInfoKey(self, key):
        return 0, len(key.values), 0
    def DeleteKeyEx(self, hive, path, access, reserved):
        del self.keys[path]
    REG_SZ = 1


class ShortReads(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2))


class NativeProtocolTests(unittest.TestCase):
    def test_partial_reads_multiple_messages_unicode_and_binary_bytes(self):
        values = [{"title": "Видео\n雪"}, {"id": "second"}]
        data = b""
        for value in values:
            payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
            data += struct.pack("<I", len(payload)) + payload
        stream = ShortReads(data)
        self.assertEqual([read_message(stream), read_message(stream)], values)
        self.assertIsNone(read_message(stream))

    def test_truncation_bad_lengths_encoding_and_non_object(self):
        for data in (b"\x01", struct.pack("<I", 5) + b"{}", struct.pack("<I", 0),
                     struct.pack("<I", MAX_MESSAGE_BYTES + 1),
                     struct.pack("<I", 1) + b"\xff", struct.pack("<I", 2) + b"[]"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                read_message(ShortReads(data))


class RegistrationInputTests(unittest.TestCase):
    def test_real_ids_only_and_deduplication(self):
        self.assertEqual(validate_extension_ids(["a" * 32] * 2), ["a" * 32])
        for ids in ([], ["A" * 32], ["a" * 31], ["q" * 32], ["a" * 32 + "/"]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                validate_extension_ids(ids)

    def test_launcher_quotes_paths_preserves_browser_arguments_and_rejects_expansion(self):
        text = launcher_text(r"C:\Python 3\python.exe", r"C:\Видео\native_host.py")
        self.assertIn('"C:\\Python 3\\python.exe" -E -s -X utf8 -u "C:\\Видео\\native_host.py" %*', text)
        self.assertIn("DisableDelayedExpansion", text)
        for path in ('C:\\%TEMP%\\python.exe', 'C:\\bad"path', 'C:\\bad\npath'):
            with self.assertRaises(ValueError):
                launcher_text(path, "host.py")

    def test_install_repeat_uninstall_preserves_other_values_and_refuses_takeover(self):
        registry = Registry()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "python.exe").touch()
            (root / "native_host.py").touch()
            with patch.dict(sys.modules, winreg=registry), patch.object(sys, "executable", str(root / "python.exe")), patch.object(sys, "version_info", (3, 11)), patch("builtins.print"):
                for _ in range(2):
                    windows_native_install.install(root, ["a" * 32, "b" * 32], ["chrome", "edge"])
                manifest = root / "windows-native" / "local.video_downloader.json"
                values = json.loads(manifest.read_text(encoding="utf-8"))
                self.assertEqual(len(values["allowed_origins"]), 2)
                self.assertTrue(Path(values["path"]).is_absolute())
                chrome = windows_native_install.REGISTRY_PATHS["chrome"]
                registry.keys[chrome]["keep"] = "foreign value"
                windows_native_install.install(root, [], ["chrome", "edge"], uninstall=True)
                windows_native_install.install(root, [], ["chrome", "edge"], uninstall=True)
                self.assertEqual(registry.keys[chrome], {"keep": "foreign value"})
                registry.keys[chrome][""] = str(root / "another.json")
                before = manifest.read_bytes()
                with self.assertRaisesRegex(ValueError, "Другая регистрация"):
                    windows_native_install.install(root, ["a" * 32], ["chrome", "edge"])
                self.assertEqual(manifest.read_bytes(), before)
                with self.assertRaises(ValueError):
                    windows_native_install.install(root, [], ["chrome"], uninstall=True)

    def test_macos_profile_keeps_shell_wrapper_and_path_identity(self):
        import install_native_host
        with tempfile.TemporaryDirectory() as folder, patch.object(sys, "platform", "darwin"), patch.object(sys, "argv", ["install_native_host.py", "--user-data-dir", folder]), patch("install_native_host.os.chmod"), patch("builtins.print"):
            self.assertEqual(install_native_host.main(), 0)
            manifest = json.loads(Path(folder, "NativeMessagingHosts", "local.video_downloader.json").read_text())
            self.assertEqual(manifest["path"], str(Path(install_native_host.HERE, "native_host.sh")))
            expected_id = install_native_host.extension_id(str(Path(install_native_host.HERE, "extension")))
            self.assertEqual(manifest["allowed_origins"], [f"chrome-extension://{expected_id}/"])


if __name__ == "__main__":
    unittest.main()
