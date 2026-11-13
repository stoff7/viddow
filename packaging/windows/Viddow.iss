#ifndef AppVersion
#define AppVersion "3.5.0-test.1"
#endif
[Setup]
AppId=ViddowWindowsPersonalTest
AppName=Viddow (Windows test)
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Viddow-Test
DefaultGroupName=Viddow Test
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir=..\..\dist\windows
OutputBaseFilename=Viddow-Setup-{#AppVersion}-windows-x64
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName=Viddow (Windows test)
SetupLogging=yes
AppMutex=Local\ViddowTestHostActive
SetupMutex=Local\ViddowTestSetup

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\dist\ViddowHost\*"; DestDir: "{app}\{#AppVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "WINDOWS-TEST.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Инструкция проверки"; Filename: "{app}\WINDOWS-TEST.md"
Name: "{group}\Журналы Viddow"; Filename: "{localappdata}\Viddow\logs"
Name: "{group}\Удалить Viddow Test"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "{app}\{#AppVersion}\ViddowHost.exe"; Parameters: "--unregister"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterViddow"

[Code]
var
  IDs: TInputQueryWizardPage;

function ValidID(Value: String): Boolean;
var I: Integer;
begin
  Result := Length(Value) = 32;
  if Result then
    for I := 1 to Length(Value) do
      if (Value[I] < 'a') or (Value[I] > 'p') then Result := False;
end;

procedure InitializeWizard;
begin
  IDs := CreateInputQueryPage(wpSelectDir, 'Подключение расширения',
    'Установите расширение отдельно в Chrome или Edge',
    'Скопируйте ID из chrome://extensions или edge://extensions (режим разработчика).' + #13#10 +
    'Заполните хотя бы одно поле. Пустое поле оставляет браузер без изменений.' + #13#10 +
    'Перед повторной установкой закройте браузеры и дождитесь завершения загрузок.');
  IDs.Add('Chrome: ID расширения', False);
  IDs.Add('Edge: ID расширения', False);
  IDs.Values[0] := GetPreviousData('ChromeID', '');
  IDs.Values[1] := GetPreviousData('EdgeID', '');
  IDs.Values[0] := ExpandConstant('{param:ChromeID|' + IDs.Values[0] + '}');
  IDs.Values[1] := ExpandConstant('{param:EdgeID|' + IDs.Values[1] + '}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = IDs.ID then begin
    Result := ((IDs.Values[0] <> '') or (IDs.Values[1] <> '')) and
      ((IDs.Values[0] = '') or ValidID(IDs.Values[0])) and
      ((IDs.Values[1] = '') or ValidID(IDs.Values[1]));
    if not Result then MsgBox('Нужен ID: ровно 32 буквы a–p. Заполните хотя бы один браузер.', mbError, MB_OK);
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'ChromeID', IDs.Values[0]);
  SetPreviousData(PreviousDataKey, 'EdgeID', IDs.Values[1]);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer; Args: String;
begin
  if CurStep = ssPostInstall then begin
    if not NextButtonClick(IDs.ID) then RaiseException('Неверный ID расширения');
    Args := '--register';
    if IDs.Values[0] <> '' then Args := Args + ' chrome=' + IDs.Values[0];
    if IDs.Values[1] <> '' then Args := Args + ' edge=' + IDs.Values[1];
    if not Exec(ExpandConstant('{app}\{#AppVersion}\ViddowHost.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      RaiseException('Не удалось подключить помощник. Подробности: %LOCALAPPDATA%\Viddow\logs\installer-error.txt. Прежняя регистрация сохранена.');
  end;
end;
