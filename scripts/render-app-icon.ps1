Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $projectRoot 'electron\assets\app-icon.png'
$outputDirectory = Split-Path -Parent $outputPath
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-RoundedRectPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundedRect($graphics, [System.Drawing.Brush]$brush, [float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-RoundedRectPath $x $y $width $height $radius
  $graphics.FillPath($brush, $path)
  $path.Dispose()
}

$navy = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#173f68'))
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$photoBackground = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#eaf3f9'))
$orange = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#e88920'))
$orangeLight = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#f59e0b'))
$mountainBack = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#4e8d86'))
$mountainFront = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#2f6f8f'))

Fill-RoundedRect $graphics $navy 0 0 512 512 104
Fill-RoundedRect $graphics $white 98 70 316 288 44
Fill-RoundedRect $graphics $photoBackground 132 106 248 182 26
$graphics.FillEllipse($orangeLight, 300, 132, 48, 48)

$backMountain = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(148, 264), [System.Drawing.PointF]::new(210, 194),
  [System.Drawing.PointF]::new(258, 244), [System.Drawing.PointF]::new(292, 210),
  [System.Drawing.PointF]::new(364, 264)
)
$frontMountain = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(148, 264), [System.Drawing.PointF]::new(210, 194),
  [System.Drawing.PointF]::new(258, 244), [System.Drawing.PointF]::new(278, 224),
  [System.Drawing.PointF]::new(324, 264)
)
$graphics.FillPolygon($mountainBack, $backMountain)
$graphics.FillPolygon($mountainFront, $frontMountain)

$archivePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$archivePath.AddPolygon([System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(76, 320), [System.Drawing.PointF]::new(436, 320),
  [System.Drawing.PointF]::new(408, 430), [System.Drawing.PointF]::new(384, 448),
  [System.Drawing.PointF]::new(128, 448), [System.Drawing.PointF]::new(104, 430)
))
$graphics.FillPath($orange, $archivePath)
$graphics.FillRectangle($orangeLight, 76, 320, 360, 40)
Fill-RoundedRect $graphics $white 208 380 96 20 10

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$archivePath.Dispose()
$navy.Dispose()
$white.Dispose()
$photoBackground.Dispose()
$orange.Dispose()
$orangeLight.Dispose()
$mountainBack.Dispose()
$mountainFront.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $outputPath
