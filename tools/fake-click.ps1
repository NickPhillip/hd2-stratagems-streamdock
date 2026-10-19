# Teste: simula um clique esquerdo (sem mover o mouse) ou, com -Ctrl, um toque no Ctrl esquerdo.
# Use só com keylog-test.ps1 ativo, que bloqueia o clique para ele não chegar a nenhuma janela.
param([switch]$Ctrl, [switch]$Down, [switch]$Up)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FakeClick {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public MOUSEINPUT mi; } // type 0 = INPUT_MOUSE
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
    public static void Click() {
        var i = new INPUT[2];
        i[0].mi.dwFlags = 0x2; // LEFTDOWN
        i[1].mi.dwFlags = 0x4; // LEFTUP
        SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Button(bool up) {
        var i = new INPUT[1];
        i[0].mi.dwFlags = up ? 0x4u : 0x2u;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    public static void CtrlTap() {
        keybd_event(0xA2, 0x1D, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(0xA2, 0x1D, 2, IntPtr.Zero);
    }
}
'@
if ($Ctrl) { [FakeClick]::CtrlTap() }
elseif ($Down) { [FakeClick]::Button($false) }
elseif ($Up) { [FakeClick]::Button($true) }
else { [FakeClick]::Click() }
