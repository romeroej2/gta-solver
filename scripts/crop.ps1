# Slice cheat-sheet (scripts/cheatsheet.png, 1500x1900) into per-print reference assets.
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile("D:\exa-tec\GTA-Solver\scripts\cheatsheet.png")
$outDir = "D:\exa-tec\GTA-Solver\src\assets\refs"
New-Item -ItemType Directory -Force $outDir | Out-Null

function Crop($x, $y, $w, $h, $outW, $outH, $name) {
    $bmp = New-Object System.Drawing.Bitmap($outW, $outH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src,
        (New-Object System.Drawing.Rectangle(0, 0, $outW, $outH)),
        (New-Object System.Drawing.Rectangle($x, $y, $w, $h)),
        [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bmp.Save("$outDir\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# targets: x y w h  (aspect ~1:1.25 to match app guide box)
$targets = @(
    @(110, 60, 420, 525),
    @(870, 60, 420, 525),
    @(110, 1020, 420, 525),
    @(870, 1020, 420, 525)
)
# component rows: startX y size gap
$compRows = @(
    @(103, 772, 118, 132),
    @(868, 772, 118, 132),
    @(103, 1720, 118, 132),
    @(868, 1720, 118, 132)
)

for ($p = 0; $p -lt 4; $p++) {
    $t = $targets[$p]
    Crop $t[0] $t[1] $t[2] $t[3] 200 250 "print$($p + 1)-target"
    $r = $compRows[$p]
    # inset past the white border frame — live captures exclude it too
    $inset = 12
    for ($c = 0; $c -lt 4; $c++) {
        Crop ($r[0] + $c * $r[3] + $inset) ($r[1] + $inset) ($r[2] - 2 * $inset) ($r[2] - 2 * $inset) 128 128 "print$($p + 1)-comp$($c + 1)"
    }
}
$src.Dispose()
Get-ChildItem $outDir | Select-Object Name, Length
