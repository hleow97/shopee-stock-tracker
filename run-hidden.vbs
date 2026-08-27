' Launches the tracker with no visible console window.
' Used by the "Shopee restock tracker" scheduled task so the 15-minute
' check doesn't flash a black box over whatever you're doing.
Dim shell, nodeExe, script
Set shell = CreateObject("WScript.Shell")
nodeExe = "C:\Program Files\nodejs\node.exe"
script = "C:\Users\leowh\shopee-stock-tracker\tracker.js"
' Third argument True = wait for node to finish. This matters: if the shim
' returns immediately, Task Scheduler marks the task complete while the work is
' still running, which defeats its MultipleInstances guard and lets two checks
' overlap.
shell.Run """" & nodeExe & """ """ & script & """", 0, True
