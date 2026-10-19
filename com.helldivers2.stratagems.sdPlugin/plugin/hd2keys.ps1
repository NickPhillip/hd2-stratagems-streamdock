# Processo auxiliar do plugin. Fica aberto e recebe comandos pelo stdin, um por linha:
#
#   <codigo> <teclas> <menu> <modo> <espera> <pressao> <intervalo>
#       Abre o menu de estratégias e digita a sequência (SendInput com scancodes; jogos
#       costumam ignorar teclas virtuais simples).
#       codigo    letras U/D/L/R, ex.: RRDLRD
#       teclas    arrows | wasd
#       menu      ctrl | alt | shift | none
#       modo      toggle (um toque abre o menu, que fecha sozinho ao completar o código)
#                 hold   (tecla segurada durante toda a sequência)
#       espera    ms entre abrir o menu e a primeira direção
#       pressao   ms que cada direção fica pressionada
#       intervalo ms entre uma direção e a próxima
#     Resposta: "OK <codigo>" ou "ERR <mensagem>"
#
#   ARM <processo> [injetado] [cancelar]
#       Passa a observar o próximo arremesso (botão esquerdo solto) feito com <processo>
#       (ex.: helldivers2) em primeiro plano; "*" aceita qualquer janela. Responde "CLICK" uma vez.
#       injetado=1 também aceita cliques simulados (usado só em testes).
#       cancelar=ctrl|alt|shift: se essa tecla for apertada antes do clique, responde "CANCEL".
#   DISARM
#       Para de observar.
#
# O gancho de mouse só fica instalado entre ARM e o clique/DISARM, e apenas observa:
# nenhum clique é bloqueado ou alterado.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class Hd2Keys {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] inputs, int size);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;

    static readonly object outLock = new object();

    // Saída compartilhada entre o fluxo principal e a thread do mouse.
    public static void Out(string line) {
        lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    static void Send(ushort vk, ushort scan, uint flags) {
        var i = new INPUT[1];
        i[0].type = INPUT_KEYBOARD;
        i[0].u.ki.wVk = vk;
        i[0].u.ki.wScan = scan;
        i[0].u.ki.dwFlags = flags;
        if (SendInput(1, i, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("SendInput falhou: " + Marshal.GetLastWin32Error());
    }

    // Direções: só scancode (o que o jogo lê do hardware).
    static void Key(ushort scan, bool extended, bool up) {
        Send(0, scan, KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0));
    }

    // Tecla do menu: código virtual + scancode, como um teclado real, para que o jogo a veja
    // tanto pelo estado da tecla (VK_LCONTROL) quanto pela entrada bruta (scancode).
    static void MenuKey(ushort vk, ushort scan, bool up) {
        Send(vk, scan, up ? KEYEVENTF_KEYUP : 0);
    }

    static int lastEndTick = 0;
    static int lastPause = 0;

    public static void Sequence(string code, bool wasd, ushort menuVk, ushort menuScan, bool toggle,
                                int wait, int hold, int gap) {
        // Dá tempo ao jogo de fechar o menu da sequência anterior. A pausa fica aqui, no início,
        // e não no fim: assim o "OK" sai logo após a última seta e a espera do arremesso começa já.
        int since = Environment.TickCount - lastEndTick;
        if (since >= 0 && since < lastPause) Thread.Sleep(lastPause - since);
        bool menuHeld = false;
        try {
            if (menuScan != 0) {
                MenuKey(menuVk, menuScan, false);
                if (toggle) { Thread.Sleep(hold); MenuKey(menuVk, menuScan, true); }
                else menuHeld = true;
                Thread.Sleep(wait);
            }
            for (int n = 0; n < code.Length; n++) {
                ushort scan; bool ext = !wasd;
                switch (code[n]) {
                    case 'U': scan = (ushort)(wasd ? 0x11 : 0x48); break;
                    case 'D': scan = (ushort)(wasd ? 0x1F : 0x50); break;
                    case 'L': scan = (ushort)(wasd ? 0x1E : 0x4B); break;
                    case 'R': scan = (ushort)(wasd ? 0x20 : 0x4D); break;
                    default: throw new Exception("direção inválida: " + code[n]);
                }
                Key(scan, ext, false);
                Thread.Sleep(hold);
                Key(scan, ext, true);
                if (n < code.Length - 1) Thread.Sleep(gap);
            }
            Thread.Sleep(hold);
        } finally {
            if (menuHeld) MenuKey(menuVk, menuScan, true);
            lastEndTick = Environment.TickCount;
            lastPause = Math.Max(wait, 50);
        }
    }

    // ---- observador de arremesso
    // No jogo a bola é lançada ao SOLTAR o botão esquerdo (apertar mira). Por isso os detectores
    // reagem ao soltar: funciona mesmo se o botão já estava apertado quando a espera começou.
    // Três detectores independentes, ativos só entre ARM e o arremesso/DISARM. O primeiro que vir
    // o botão ser solto com o jogo em primeiro plano vale. Anti-cheats (ex.: GameGuard) podem
    // neutralizar alguns deles; cada detecção sai no log como "DBG" para diagnóstico.
    //   hook - gancho de mouse de baixo nível (WH_MOUSE_LL)
    //   raw  - Raw Input em segundo plano (RIDEV_INPUTSINK), o mesmo canal que jogos usam
    //   poll - leitura periódica do estado do botão (GetAsyncKeyState)
    // Nenhum deles bloqueia ou altera o clique.
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h,
                                        IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint n, uint size);
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr h, uint cmd, byte[] data, ref uint size, uint header);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    const int WH_MOUSE_LL = 14;
    const uint WM_LBUTTONUP = 0x0202, WM_INPUT = 0x00FF, WM_ARM = 0x8001, WM_DISARM = 0x8002;
    const uint LLMHF_INJECTED = 0x1;
    const uint RIDEV_REMOVE = 0x1, RIDEV_INPUTSINK = 0x100, RID_INPUT = 0x10000003;

    static HookProc mouseProc = MouseHook;
    static IntPtr mouseHook = IntPtr.Zero;
    static IntPtr rawWindow = IntPtr.Zero;
    static bool rawOn = false;
    static uint mouseThread;
    static volatile string armProcess = null;
    static volatile bool armInjected = false;
    static readonly object clickLock = new object();
    static int lastClickTick = 0;

    public static void StartMouseWatcher() {
        var ready = new ManualResetEvent(false);
        var t = new Thread(() => {
            MSG m;
            mouseThread = GetCurrentThreadId();
            PeekMessage(out m, IntPtr.Zero, 0, 0, 0); // cria a fila de mensagens da thread
            // Janela invisível só de mensagens (HWND_MESSAGE) para receber o Raw Input.
            rawWindow = CreateWindowEx(0, "STATIC", "hd2raw", 0, 0, 0, 0, 0, new IntPtr(-3),
                                       IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            ready.Set();
            while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
                if (m.message == WM_ARM) { ArmOnThread(); continue; }
                if (m.message == WM_DISARM) { DisarmOnThread(); continue; }
                if (m.message == WM_INPUT) OnRawInput(m.lParam);
                DispatchMessage(ref m);
            }
        });
        t.IsBackground = true;
        t.Start();
        ready.WaitOne();

        var poll = new Thread(PollLoop);
        poll.IsBackground = true;
        poll.Start();
    }

    static void ArmOnThread() {
        if (mouseHook == IntPtr.Zero) {
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
            if (mouseHook == IntPtr.Zero) Out("DBG hook não instalado, erro " + Marshal.GetLastWin32Error());
        }
        if (!rawOn && rawWindow != IntPtr.Zero) {
            var d = new RAWINPUTDEVICE[1];
            d[0].usUsagePage = 0x01; d[0].usUsage = 0x02; // mouse
            d[0].dwFlags = RIDEV_INPUTSINK; d[0].hwndTarget = rawWindow;
            rawOn = RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
            if (!rawOn) Out("DBG raw input não registrado, erro " + Marshal.GetLastWin32Error());
        }
    }

    static void DisarmOnThread() {
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (rawOn) {
            var d = new RAWINPUTDEVICE[1];
            d[0].usUsagePage = 0x01; d[0].usUsage = 0x02;
            d[0].dwFlags = RIDEV_REMOVE; d[0].hwndTarget = IntPtr.Zero;
            RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
            rawOn = false;
        }
    }

    static volatile int cancelVk = 0;

    public static void Arm(string process, bool injected, int cancelKey) {
        armInjected = injected;
        cancelVk = cancelKey;
        armProcess = process;
        PostThreadMessage(mouseThread, WM_ARM, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Disarm() {
        armProcess = null;
        PostThreadMessage(mouseThread, WM_DISARM, IntPtr.Zero, IntPtr.Zero);
    }

    // Nome do processo em primeiro plano, ou null quando o Windows não informa a janela
    // (o anti-cheat do jogo esconde a janela do Helldivers 2 de outros programas).
    static string ForegroundName() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return null;
        try { return Process.GetProcessById((int)pid).ProcessName; }
        catch { return "?(pid " + pid + ")"; }
    }

    static bool IsRunning(string process) {
        try { return Process.GetProcessesByName(process).Length > 0; }
        catch { return false; }
    }

    // Chamado pelos três detectores. Também registra detecções logo após um CLICK (mesmo clique
    // visto por outro detector) para sabermos quais funcionam.
    static void Detected(string source, bool injected) {
        lock (clickLock) {
            string proc = armProcess;
            int now = Environment.TickCount;
            if (proc == null) {
                if (now - lastClickTick < 500) Out("DBG clique fonte=" + source + " (mesmo clique)");
                return;
            }
            string fg = ForegroundName();
            // Janela oculta + jogo rodando = clique no jogo.
            bool match = proc == "*" || string.Equals(fg, proc, StringComparison.OrdinalIgnoreCase)
                         || (fg == null && IsRunning(proc));
            Out("DBG clique fonte=" + source + " janela=" + (fg ?? "(oculta)") + (injected ? " simulado" : "") + (match ? "" : " (ignorado)"));
            if (!match || (injected && !armInjected)) return;
            armProcess = null;
            lastClickTick = now;
            PostThreadMessage(mouseThread, WM_DISARM, IntPtr.Zero, IntPtr.Zero);
            Out("CLICK");
        }
    }

    static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && (uint)wParam == WM_LBUTTONUP) {
            var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            Detected("hook", (info.flags & LLMHF_INJECTED) != 0);
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam); // nunca bloqueia o clique
    }

    static void OnRawInput(IntPtr hRaw) {
        uint size = 0;
        uint header = (uint)(8 + 2 * IntPtr.Size); // RAWINPUTHEADER
        GetRawInputData(hRaw, RID_INPUT, null, ref size, header);
        if (size == 0 || size > 1024) return;
        var buf = new byte[size];
        if (GetRawInputData(hRaw, RID_INPUT, buf, ref size, header) == unchecked((uint)-1)) return;
        if (BitConverter.ToUInt32(buf, 0) != 0) return; // RIM_TYPEMOUSE
        IntPtr device = IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(buf, 8)) : new IntPtr(BitConverter.ToInt32(buf, 8));
        ushort buttonFlags = BitConverter.ToUInt16(buf, (int)header + 4); // RAWMOUSE.usButtonFlags
        if ((buttonFlags & 0x0002) != 0) Detected("raw", device == IntPtr.Zero); // RI_MOUSE_LEFT_BUTTON_UP
    }

    static void PollLoop() {
        bool wasDown = false;   // botão esquerdo estava apertado na leitura anterior
        bool cancelWas = true;  // só conta a tecla do menu apertada depois de armar
        for (;;) {
            bool down = (GetAsyncKeyState(0x01) & 0x8000) != 0; // VK_LBUTTON
            if (armProcess == null) {
                // Desarmado: acompanha o estado para perceber um botão apertado antes de armar.
                wasDown = down; cancelWas = true; Thread.Sleep(20); continue;
            }
            if (!down && wasDown) Detected("poll", false); // soltou = arremesso
            wasDown = down;

            // Tecla do menu apertada com a bola na mão = jogador cancelou/reabriu o menu.
            int vk = cancelVk;
            if (vk != 0) {
                bool c = (GetAsyncKeyState(vk) & 0x8000) != 0;
                if (c && !cancelWas) Cancelled();
                cancelWas = c;
            }
            Thread.Sleep(5);
        }
    }

    static void Cancelled() {
        lock (clickLock) {
            string proc = armProcess;
            if (proc == null) return;
            string fg = ForegroundName();
            bool match = proc == "*" || string.Equals(fg, proc, StringComparison.OrdinalIgnoreCase)
                         || (fg == null && IsRunning(proc));
            Out("DBG tecla do menu janela=" + (fg ?? "(oculta)") + (match ? "" : " (ignorada)"));
            if (!match) return;
            armProcess = null;
            PostThreadMessage(mouseThread, WM_DISARM, IntPtr.Zero, IntPtr.Zero);
            Out("CANCEL");
        }
    }
}
'@

# Tecla do menu: código virtual (VK_LCONTROL / VK_LMENU / VK_LSHIFT) e scancode.
$menuKeys = @{ ctrl = @(0xA2, 0x1D); alt = @(0xA4, 0x38); shift = @(0xA0, 0x2A); none = @(0, 0) }

[Hd2Keys]::StartMouseWatcher()
[Hd2Keys]::Out('READY')

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $p = $line.Trim().Split(' ')
    if ($p.Length -eq 0 -or $p[0] -eq '') { continue }
    try {
        if ($p[0] -eq 'ARM') {
            if ($p.Length -lt 2) { throw 'ARM sem processo' }
            # ARM <processo> [injetado 0/1] [tecla de cancelar: ctrl|alt|shift|none]
            $cancel = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; none = 0 }
            $ck = if ($p.Length -ge 4 -and $cancel.ContainsKey($p[3])) { $cancel[$p[3]] } else { 0 }
            [Hd2Keys]::Arm($p[1], $p.Length -ge 3 -and $p[2] -eq '1', $ck)
            continue
        }
        if ($p[0] -eq 'DISARM') { [Hd2Keys]::Disarm(); continue }

        if ($p.Length -ne 7) { throw "esperado 7 campos, recebido $($p.Length)" }
        $code = $p[0].ToUpperInvariant()
        if ($code -notmatch '^[UDLR]{1,16}$') { throw "código inválido: $code" }
        if (-not $menuKeys.ContainsKey($p[2])) { throw "tecla de menu inválida: $($p[2])" }
        $mk = $menuKeys[$p[2]]
        [Hd2Keys]::Sequence($code, $p[1] -eq 'wasd', [uint16]$mk[0], [uint16]$mk[1], $p[3] -ne 'hold',
            [int]$p[4], [int]$p[5], [int]$p[6])
        [Hd2Keys]::Out("OK $code")
    } catch {
        [Hd2Keys]::Out("ERR $($_.Exception.Message)")
    }
}
