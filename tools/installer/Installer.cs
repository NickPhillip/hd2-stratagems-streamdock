// Instalador do plugin "Helldivers 2 Stratagems" para Stream Dock / fifine Control Deck.
// Um único .exe: o plugin vai embutido como recurso (plugin.zip).
// Compilado com o csc do .NET Framework 4.x que vem no Windows (C# 5): veja tools/make-installer.ps1.
//
// Uso normal: dois cliques. Instala, atualiza ou desinstala, fechando e reabrindo o app do deck.
// Testes: Setup.exe /silent [/target <pasta de plugins>] [/uninstall]
//   /silent    sem janelas; não fecha nem abre o app; resultado em %TEMP%\hd2-setup.log
//   /target    instala em outra pasta de plugins
//   /uninstall remove em vez de instalar
//   /detect    só lista no log os apps do deck em execução (não instala nada)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Helldivers 2 Stratagems - Setup")]
[assembly: AssemblyProduct("Helldivers 2 Stratagems for Stream Dock")]
[assembly: AssemblyDescription("Installs the Helldivers 2 Stratagems plugin for Stream Dock / fifine Control Deck")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Setup
{
    const string PluginFolder = "com.helldivers2.stratagems.sdPlugin";
    const string Title = "Helldivers 2 Stratagems";

    static bool silent;
    static StreamWriter logFile;

    [STAThread]
    static int Main(string[] args)
    {
        string target = null;
        bool uninstall = false, detect = false;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].ToLowerInvariant();
            if (a == "/silent") silent = true;
            else if (a == "/uninstall") uninstall = true;
            else if (a == "/detect") { detect = true; silent = true; }
            else if (a == "/target" && i + 1 < args.Length) target = args[++i];
        }
        if (silent) logFile = new StreamWriter(Path.Combine(Path.GetTempPath(), "hd2-setup.log"), false);
        try
        {
            if (detect)
            {
                foreach (Process p in FindDeckApps()) Log("app do deck: " + p.ProcessName + " (" + ExePath(p) + ")");
                Log("fim da detecção");
                return 0;
            }
            return Run(target, uninstall);
        }
        catch (Exception e)
        {
            Error("Something went wrong:\n\n" + e.Message);
            return 1;
        }
        finally
        {
            if (logFile != null) logFile.Dispose();
        }
    }

    static int Run(string target, bool uninstall)
    {
        Application.EnableVisualStyles();

        // 1. Pasta de plugins do app do deck (Stream Dock e apps baseados nele, ex.: fifine Control Deck).
        string pluginsDir = target;
        if (pluginsDir == null)
        {
            string appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HotSpot", "StreamDock");
            if (!Directory.Exists(appData))
            {
                Error("Stream Dock / fifine Control Deck was not found on this PC.\n\n" +
                      "Install the deck app, open it once, then run this setup again.");
                return 2;
            }
            pluginsDir = Path.Combine(appData, "plugins");
        }
        Directory.CreateDirectory(pluginsDir);
        string dest = Path.Combine(pluginsDir, PluginFolder);
        bool installed = File.Exists(Path.Combine(dest, "manifest.json"));

        // 2. O que fazer: instalar, ou (se já instalado) atualizar / desinstalar.
        if (!silent)
        {
            if (installed)
            {
                DialogResult r = MessageBox.Show(
                    "Helldivers 2 Stratagems is already installed.\n\n" +
                    "Yes = Update / reinstall\nNo = Uninstall\nCancel = Do nothing",
                    Title, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (r == DialogResult.Cancel) return 0;
                uninstall = r == DialogResult.No;
            }
            else
            {
                DialogResult r = MessageBox.Show(
                    "Install the Helldivers 2 Stratagems plugin for Stream Dock / fifine Control Deck?",
                    Title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (r != DialogResult.OK) return 0;
            }
        }

        // 3. O app do deck precisa estar fechado (ele mantém os arquivos do plugin em uso).
        string appExe = null;
        if (!silent)
        {
            List<Process> running = FindDeckApps();
            if (running.Count > 0)
            {
                appExe = ExePath(running[0]);
                DialogResult r = MessageBox.Show(
                    "The deck app is open and needs to be closed for a moment.\n\n" +
                    "Close it now? It will be opened again when setup finishes.",
                    Title, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
                if (r != DialogResult.OK) return 0;
                CloseDeckApps(running);
            }
        }

        // 4. Remove a versão anterior (as configurações do usuário ficam em %LOCALAPPDATA% e são mantidas).
        if (Directory.Exists(dest)) DeleteWithRetry(dest);

        if (uninstall)
        {
            Log("removido: " + dest);
            Reopen(appExe);
            Info("Helldivers 2 Stratagems was uninstalled.");
            return 0;
        }

        // 5. Extrai o plugin embutido.
        int files = 0;
        using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("plugin.zip"))
        using (ZipArchive zip = new ZipArchive(res, ZipArchiveMode.Read))
        {
            string root = Path.GetFullPath(pluginsDir) + Path.DirectorySeparatorChar;
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                if (string.IsNullOrEmpty(e.Name)) continue; // pasta
                string path = Path.GetFullPath(Path.Combine(pluginsDir, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // caminho fora da pasta
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                e.ExtractToFile(path, true);
                files++;
            }
        }
        Log("instalado: " + dest + " (" + files + " arquivos)");

        // 6. Reabre o app, se estava aberto.
        Reopen(appExe);
        Info("Helldivers 2 Stratagems was installed!\n\n" +
             "In the deck app, find the \"Helldivers 2\" category in the action list and drag the stratagems " +
             "onto your keys.\n\nTip: click any Helldivers key to open its settings and set \"Menu mode\" to " +
             "match your game settings.");
        return 0;
    }

    // Processos do app do deck: o executável fica numa pasta com SDLibrary1.dll (biblioteca do Stream Dock).
    static List<Process> FindDeckApps()
    {
        List<Process> found = new List<Process>();
        foreach (Process p in Process.GetProcesses())
        {
            string exe = ExePath(p);
            if (exe == null || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
            string dir = Path.GetDirectoryName(exe);
            if (File.Exists(Path.Combine(dir, "SDLibrary1.dll")) && File.Exists(Path.Combine(dir, "QCefView.dll")))
                found.Add(p);
        }
        return found;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr process, int flags, System.Text.StringBuilder name, ref int size);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // Caminho do executável pedindo só PROCESS_QUERY_LIMITED_INFORMATION: não lê a memória do
    // processo (Process.MainModule lê, e pode travar em processos protegidos por anti-cheat).
    static string ExePath(Process p)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, p.Id);
            if (h == IntPtr.Zero) return null;
            System.Text.StringBuilder sb = new System.Text.StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null;
        }
        catch { return null; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    static void CloseDeckApps(List<Process> apps)
    {
        foreach (Process p in apps)
        {
            string dir = Path.GetDirectoryName(ExePath(p) ?? "");
            try { p.CloseMainWindow(); } catch { }
            if (!p.WaitForExit(5000)) { try { p.Kill(); p.WaitForExit(5000); } catch { } }
            // Processos auxiliares do app (ex.: Node dos plugins) que ainda estejam rodando.
            foreach (Process q in Process.GetProcesses())
            {
                string exe = ExePath(q);
                if (exe != null && dir.Length > 0 && exe.StartsWith(dir, StringComparison.OrdinalIgnoreCase))
                {
                    try { q.Kill(); q.WaitForExit(3000); } catch { }
                }
            }
        }
        Thread.Sleep(1000);
    }

    static void DeleteWithRetry(string dir)
    {
        for (int i = 0; ; i++)
        {
            try { Directory.Delete(dir, true); return; }
            catch (IOException) { if (i >= 10) throw; Thread.Sleep(500); }
            catch (UnauthorizedAccessException) { if (i >= 10) throw; Thread.Sleep(500); }
        }
    }

    static void Reopen(string exe)
    {
        if (exe == null) return;
        try { Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = Path.GetDirectoryName(exe) }); }
        catch { }
    }

    static void Info(string text)
    {
        Log(text);
        if (!silent) MessageBox.Show(text, Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    static void Error(string text)
    {
        Log("ERRO: " + text);
        if (!silent) MessageBox.Show(text, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static void Log(string text)
    {
        if (logFile != null) { logFile.WriteLine(text); logFile.Flush(); }
    }
}
