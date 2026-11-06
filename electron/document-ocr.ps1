# Fixed local helper. Document bytes are data, never PowerShell input.
# Uses the Windows PDF renderer and installed OCR languages. No network calls.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Result($Value) {
    [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

$pdf = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

    $operationAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
        Select-Object -First 1
    $actionAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.FullName -eq 'Windows.Foundation.IAsyncAction' } |
        Select-Object -First 1
    if ($null -eq $operationAsTask -or $null -eq $actionAsTask) { throw 'Unavailable Windows async runtime' }

    function Await-Operation($Operation, [Type] $ResultType) {
        $task = $operationAsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        $task.Wait()
        return $task.Result
    }
    function Await-Action($Action) {
        $task = $actionAsTask.Invoke($null, @($Action))
        $task.Wait()
    }

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { Write-Result @{ ok = $false; code = 'ocr_language_missing' }; exit 0 }
    $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:GRAVITY_OCR_INPUT)) ([Windows.Storage.StorageFile])
    $pdf = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    if ($pdf.PageCount -lt 1) { Write-Result @{ ok = $false; code = 'ocr_no_text' }; exit 0 }
    if ($pdf.PageCount -gt 10) { Write-Result @{ ok = $false; code = 'ocr_page_limit' }; exit 0 }

    $parts = New-Object 'System.Collections.Generic.List[string]'
    $characters = 0
    $found = $false
    for ($index = 0; $index -lt $pdf.PageCount; $index++) {
        $page = $null; $stream = $null; $bitmap = $null
        try {
            $page = $pdf.GetPage([uint32]$index)
            $width = [double]$page.Size.Width; $height = [double]$page.Size.Height
            if ($width -le 0 -or $height -le 0 -or [double]::IsInfinity($width) -or [double]::IsInfinity($height) -or [double]::IsNaN($width) -or [double]::IsNaN($height)) { throw 'Invalid page dimensions' }
            $scale = [Math]::Min(3.0, [Math]::Min(1800.0 / $width, 1800.0 / $height))
            $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
            $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
            $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            Await-Action ($page.RenderToStreamAsync($stream, $options))
            $stream.Seek(0)
            $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            if ($bitmap.PixelWidth -gt 1800 -or $bitmap.PixelHeight -gt 1800) { throw 'Oversized page image' }
            $recognized = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $text = [string]::Join("`n", [string[]]@($recognized.Lines | ForEach-Object { $_.Text })).Trim()
            if ($text.Length -gt 0) {
                $found = $true
                $heading = 'Page ' + ($index + 1)
                $characters += $heading.Length + $text.Length + 2
                if ($characters -gt 60000) { Write-Result @{ ok = $false; code = 'text_limit' }; exit 0 }
                $parts.Add($heading); $parts.Add($text)
            }
        } finally {
            foreach ($resource in @($bitmap, $stream, $page)) { if ($null -ne $resource) { try { $resource.Dispose() } catch {} } }
        }
    }
    if (-not $found) { Write-Result @{ ok = $false; code = 'ocr_no_text' }; exit 0 }
    Write-Result @{ ok = $true; result = @{ content = [string]::Join("`n", $parts); format = 'pdf'; units = [int]$pdf.PageCount; ocr = $true; ocrLanguage = $engine.RecognizerLanguage.LanguageTag } }
} catch {
    # Fixed errors do not reveal the temporary path, PDF text or environment.
    Write-Result @{ ok = $false; code = 'ocr_failed' }
} finally {
    if ($null -ne $pdf) { try { $pdf.Dispose() } catch {} }
}
