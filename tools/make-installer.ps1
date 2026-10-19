# Gera dist\HD2-Stratagems-Setup.exe: um instalador de um arquivo só, com o plugin embutido.
# Usa o compilador C# do .NET Framework que já vem no Windows (sem instalar nada).
# Uso (na raiz do projeto): powershell -ExecutionPolicy Bypass -File tools\make-installer.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root 'com.helldivers2.stratagems.sdPlugin'
$dist = Join-Path $root 'dist'
$work = Join-Path ([IO.Path]::GetTempPath()) ('hd2-setup-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $dist, $work | Out-Null

try {
    # 1. Plugin compactado (caminhos com "/", sem o log local), embutido como recurso.
    $zipPath = Join-Path $work 'plugin.zip'
    $zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
    try {
        Get-ChildItem -LiteralPath $plugin -Recurse -File | Where-Object { $_.Name -ne 'plugin.log' } | ForEach-Object {
            $rel = 'com.helldivers2.stratagems.sdPlugin/' + $_.FullName.Substring($plugin.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal')
        }
    } finally { $zip.Dispose() }

    # 2. Ícone do .exe: arquivo .ico contendo o PNG do ícone do plugin (formato aceito desde o Vista).
    $png = [IO.File]::ReadAllBytes((Join-Path $plugin 'images\plugin@2x.png'))
    $ico = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter $ico
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)    # cabeçalho: ícone, 1 imagem
    $w.Write([byte]0); $w.Write([byte]0)                               # largura/altura 0 = 256 (PNG define o tamanho real)
    $w.Write([byte]0); $w.Write([byte]0)                               # paleta, reservado
    $w.Write([uint16]1); $w.Write([uint16]32)                          # planos, bits por pixel
    $w.Write([uint32]$png.Length); $w.Write([uint32]22)                # tamanho e posição dos dados
    $w.Write($png); $w.Flush()
    $icoPath = Join-Path $work 'setup.ico'
    [IO.File]::WriteAllBytes($icoPath, $ico.ToArray())

    # 3. Compila.
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $out = Join-Path $dist 'HD2-Stratagems-Setup.exe'
    & $csc /nologo /target:winexe /optimize+ "/out:$out" "/win32icon:$icoPath" "/resource:$zipPath,plugin.zip" `
        /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
        (Join-Path $PSScriptRoot 'installer\Installer.cs')
    if ($LASTEXITCODE -ne 0) { throw "csc falhou ($LASTEXITCODE)" }
    "gerado: $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
