# Teste: instala um hook de teclado de baixo nível por alguns segundos, registra as teclas
# INJETADAS (as do plugin) e as bloqueia para não chegarem a nenhuma janela.
# Uso: powershell -File keylog-test.ps1 <segundos> <arquivo-log>
param([int]$Seconds = 8, [string]$LogFile = 'keylog.txt', [switch]$PassCtrl)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class KeyLog {
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr fn);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    public static bool PassCtrl = false;
    static HookProc proc = Hook;
    static HookProc mproc = MouseHook;

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }

    // Cliques simulados também são registrados e bloqueados (ganchos instalados depois deste,
    // como o do plugin, veem o clique antes).
    static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            uint msg = (uint)wParam;
            if ((m.flags & 0x1) != 0 && (msg == 0x201 || msg == 0x202)) {
                log.WriteLine("{0,6} mouse {1}", sw.ElapsedMilliseconds, msg == 0x201 ? "LDOWN" : "LUP");
                log.Flush();
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    static StreamWriter log;
    static Stopwatch sw = Stopwatch.StartNew();

    static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool injected = (k.flags & 0x10) != 0;
            // Ctrl sozinho é inofensivo: passa (para testar o cancelamento pela tecla do menu).
            bool ctrl = k.vkCode == 0xA2 || k.vkCode == 0xA3 || k.vkCode == 0x11;
            if (injected && ctrl && PassCtrl) {
                log.WriteLine("{0,6} vk=0x{1:X2} {2} (liberado)", sw.ElapsedMilliseconds, k.vkCode, (k.flags & 0x80) != 0 ? "UP" : "DOWN");
                log.Flush();
            } else if (injected) {
                log.WriteLine("{0,6} vk=0x{1:X2} scan=0x{2:X2} ext={3} {4}", sw.ElapsedMilliseconds, k.vkCode, k.scanCode,
                    (k.flags & 0x1) != 0 ? 1 : 0, (k.flags & 0x80) != 0 ? "UP" : "DOWN");
                log.Flush();
                return (IntPtr)1; // bloqueia
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    public static void Run(int seconds, string file) {
        log = new StreamWriter(file);
        IntPtr h = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
        IntPtr hm = SetWindowsHookEx(14, mproc, GetModuleHandle(null), 0);
        if (h == IntPtr.Zero || hm == IntPtr.Zero) throw new Exception("SetWindowsHookEx falhou");
        File.WriteAllText(file + ".ready", "1"); // sinaliza que o hook está ativo
        SetTimer(IntPtr.Zero, IntPtr.Zero, (uint)(seconds * 1000), IntPtr.Zero);
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
            if (m.message == 0x0113) break; // WM_TIMER
        }
        UnhookWindowsHookEx(h);
        UnhookWindowsHookEx(hm);
        log.Close();
    }
}
'@

[KeyLog]::PassCtrl = [bool]$PassCtrl
[KeyLog]::Run($Seconds, $LogFile)
