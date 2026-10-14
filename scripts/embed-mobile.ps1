$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bundlePath = Join-Path $root 'main.js'
$sourcePath = Join-Path $root 'mobile-pdf.js'
$penSourcePath = Join-Path $root 'pen-eraser.js'
$exportSourcePath = Join-Path $root 'pdf-export.js'
$webSourcePath = Join-Path $root 'web-chapters.js'
$pdfLibPath = Join-Path $root 'vendor/pdf-lib.min.js'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$bundle = [System.IO.File]::ReadAllText($bundlePath, $utf8)
$source = [System.IO.File]::ReadAllText($sourcePath, $utf8)
$penSource = [System.IO.File]::ReadAllText($penSourcePath, $utf8)
$exportSource = [System.IO.File]::ReadAllText($exportSourcePath, $utf8)
$webSource = [System.IO.File]::ReadAllText($webSourcePath, $utf8)
$pdfLibSource = [System.IO.File]::ReadAllText($pdfLibPath, $utf8).Replace('//# sourceMappingURL=pdf-lib.min.js.map', '')
$penBegin = '/* BEGIN shared pen eraser */'
$penEnd = '/* END shared pen eraser */'
$penEmbedded = "$penBegin`n$penSource$penEnd"
$exportBegin = '/* BEGIN PDF export */'
$exportEnd = '/* END PDF export */'
$exportEmbedded = "$exportBegin`n$exportSource$exportEnd"
$pdfLibBegin = '/* BEGIN pdf-lib 1.17.1 MIT */'
$pdfLibEnd = '/* END pdf-lib 1.17.1 MIT */'
$pdfLibEmbedded = "$pdfLibBegin`nvar DaPdfLib=(function(){var module={exports:{}};var exports=module.exports;`n$pdfLibSource`nreturn module.exports})();`n$pdfLibEnd"
$webBegin = '/* BEGIN web chapter previews */'
$webEnd = '/* END web chapter previews */'
$webEmbedded = "$webBegin`n$webSource$webEnd"
$begin = '/* BEGIN tablet support */'
$end = '/* END tablet support */'
$embedded = "$begin`n$source$end"

if ($bundle.Contains($begin)) {
    $start = $bundle.IndexOf($begin)
    $finish = $bundle.IndexOf($end, $start)
    if ($finish -lt 0) { throw 'Tablet support end marker is missing.' }
    $finish += $end.Length
    $bundle = $bundle.Substring(0, $start) + $embedded + $bundle.Substring($finish)
} else {
    $needle = 'var Na={'
    $index = $bundle.IndexOf($needle)
    if ($index -lt 0) { throw 'Bundle insertion point is missing.' }
    $bundle = $bundle.Substring(0, $index) + "`n$embedded`n" + $bundle.Substring($index)
}

if ($bundle.Contains($penBegin)) {
    $start = $bundle.IndexOf($penBegin)
    $finish = $bundle.IndexOf($penEnd, $start)
    if ($finish -lt 0) { throw 'Shared pen eraser end marker is missing.' }
    $finish += $penEnd.Length
    $bundle = $bundle.Substring(0, $start) + $penEmbedded + $bundle.Substring($finish)
} else {
    $index = $bundle.IndexOf($begin)
    if ($index -lt 0) { throw 'Tablet support insertion point is missing.' }
    $bundle = $bundle.Substring(0, $index) + "$penEmbedded`n" + $bundle.Substring($index)
}

if ($bundle.Contains($exportBegin)) {
    $start = $bundle.IndexOf($exportBegin)
    $finish = $bundle.IndexOf($exportEnd, $start)
    if ($finish -lt 0) { throw 'PDF export end marker is missing.' }
    $finish += $exportEnd.Length
    $bundle = $bundle.Substring(0, $start) + $exportEmbedded + $bundle.Substring($finish)
} else {
    $index = $bundle.IndexOf($begin)
    if ($index -lt 0) { throw 'PDF export insertion point is missing.' }
    $bundle = $bundle.Substring(0, $index) + "$exportEmbedded`n" + $bundle.Substring($index)
}

if ($bundle.Contains($pdfLibBegin)) {
    $start = $bundle.IndexOf($pdfLibBegin)
    $finish = $bundle.IndexOf($pdfLibEnd, $start)
    if ($finish -lt 0) { throw 'pdf-lib end marker is missing.' }
    $finish += $pdfLibEnd.Length
    $bundle = $bundle.Substring(0, $start) + $pdfLibEmbedded + $bundle.Substring($finish)
} else {
    $index = $bundle.IndexOf($exportBegin)
    if ($index -lt 0) { throw 'PDF export insertion point is missing.' }
    $bundle = $bundle.Substring(0, $index) + "$pdfLibEmbedded`n" + $bundle.Substring($index)
}

if ($bundle.Contains($webBegin)) {
    $start = $bundle.IndexOf($webBegin)
    $finish = $bundle.IndexOf($webEnd, $start)
    if ($finish -lt 0) { throw 'Web chapter previews end marker is missing.' }
    $finish += $webEnd.Length
    $bundle = $bundle.Substring(0, $start) + $webEmbedded + $bundle.Substring($finish)
} else {
    $index = $bundle.IndexOf($begin)
    if ($index -lt 0) { throw 'Web chapter previews insertion point is missing.' }
    $bundle = $bundle.Substring(0, $index) + "$webEmbedded`n" + $bundle.Substring($index)
}

$desktopPatch = 'patchOpenFileForNewTab(){let s=this,o=this.app.workspace;'
$mobilePatch = 'patchOpenFileForNewTab(){if(it.Platform?.isMobile)return;let s=this,o=this.app.workspace;'
if ($bundle.Contains($desktopPatch)) {
    $bundle = $bundle.Replace($desktopPatch, $mobilePatch)
} elseif (-not $bundle.Contains($mobilePatch) -and
          $bundle -notmatch 'patchOpenFileForNewTab\(\)\s*\{\s*if\s*\(\s*it\.Platform\?\.isMobile\s*\)\s*return\s*;') {
    throw 'PDF tab routing patch point is missing.'
}

$bundle = $bundle.Replace('onload \u2014 version 0.2.37-newtab-v5', 'onload \u2014 version 0.2.39-tablet')
$bundle = $bundle.Replace('onload \u2014 version 0.2.42-tablet', 'onload \u2014 version 0.2.39-tablet')

[System.IO.File]::WriteAllText($bundlePath, $bundle, $utf8)
