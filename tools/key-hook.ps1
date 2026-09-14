param([Parameter(Mandatory=$true)][string]$Map)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class MrmKeyHook {
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    private static readonly Dictionary<int, int> keyMap = new Dictionary<int, int>();
    private static readonly HashSet<int> pressed = new HashSet<int>();
    private static LowLevelKeyboardProc procRef;
    private static Stopwatch clock;

    private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int vk = (int)data.vkCode;
            int col;
            if (keyMap.TryGetValue(vk, out col)) {
                int msg = (int)wParam;
                bool isDown = msg == 0x100 || msg == 0x104;
                bool isUp = msg == 0x101 || msg == 0x105;
                if (isDown && pressed.Add(vk)) {
                    Console.WriteLine("down|" + col + "|" + (clock.ElapsedTicks * 1000.0 / Stopwatch.Frequency).ToString("0.0", CultureInfo.InvariantCulture));
                    Console.Out.Flush();
                } else if (isUp && pressed.Remove(vk)) {
                    Console.WriteLine("up|" + col + "|" + (clock.ElapsedTicks * 1000.0 / Stopwatch.Frequency).ToString("0.0", CultureInfo.InvariantCulture));
                    Console.Out.Flush();
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    public static void Run(string spec) {
        foreach (string pair in spec.Split(',')) {
            string[] kv = pair.Split(':');
            int vk, col;
            if (kv.Length == 2 && int.TryParse(kv[0], out vk) && int.TryParse(kv[1], out col)) keyMap[vk] = col;
        }
        clock = Stopwatch.StartNew();
        procRef = Callback;
        IntPtr hook = SetWindowsHookEx(13, procRef, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) {
            Console.Error.WriteLine("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
            Environment.Exit(1);
        }
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWindowsHookEx(hook);
    }
}
"@
[MrmKeyHook]::Run($Map)
