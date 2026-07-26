# Regenerate THIRD-PARTY-LICENSES.md from the actual dependency trees.
#
# Run before every release: `npm run licenses`.
#
# MIT requires the copyright notice to travel with the binary; Apache-2.0 adds a
# NOTICE/attribution obligation; MPL-2.0 (symphonia, cssparser) requires pointing
# at the source of the covered files. We ship unmodified upstream crates, so a
# generated attribution file discharges all three - but only if it is actually
# distributed, so tauri.conf.json lists it under bundle.resources and
# export-release.ps1 copies it next to the portable exe.
#
# Sources of truth, in order of preference:
#   Rust  - src-tauri/Cargo.lock, cross-referenced against the cargo registry
#           cache (~/.cargo/registry/src) for the license id and license text.
#   npm   - `npm ls --omit=dev --all --json` (production tree only; devDeps such
#           as vite/typescript/@tauri-apps/cli never reach a user's machine).
#   vendor- src/vendor/*, which npm and cargo know nothing about.
#
# Over-inclusion is deliberate and safe: Cargo.lock carries build-time-only
# crates too, and attributing a crate we did not ship costs nothing, while
# missing one is a license violation.

param(
    # CI mode: regenerate, then fail if the result differs from the committed
    # file. A dependency added without rerunning this script would otherwise ship
    # attributions that are quietly incomplete, which looks like compliance.
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $root "THIRD-PARTY-LICENSES.md"

# Distinct license texts, deduped by content hash: hash -> @{ Text; Packages }.
# MIT text differs per copyright holder, so this collapses far less than the
# count of packages, but far more than 1:1.
$texts = [ordered]@{}
$rows = New-Object System.Collections.ArrayList
# label -> content hash, so the JSON the About dialog reads can point each
# component at its license text without duplicating 2 MB of near-identical
# MIT boilerplate 600 times.
$pkgTextHash = @{}

function Add-LicenseText {
    param([string]$Package, [string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    # Normalize line endings and trailing space so the same license shipped with
    # CRLF and LF dedupes to one entry.
    $norm = ($Text -replace "`r`n", "`n").TrimEnd()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [System.BitConverter]::ToString(
        $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($norm))).Replace("-", "")
    $sha.Dispose()
    if (-not $texts.Contains($hash)) {
        $texts[$hash] = @{ Text = $norm; Packages = New-Object System.Collections.ArrayList }
    }
    if (-not $texts[$hash].Packages.Contains($Package)) {
        [void]$texts[$hash].Packages.Add($Package)
    }
    $pkgTextHash[$Package] = $hash
}

function Format-License {
    <#
        Canonicalize an SPDX expression so the same license spelled three ways
        groups as one. Cargo manifests use "MIT OR Apache-2.0", "Apache-2.0 OR
        MIT", and the legacy slash form "MIT/Apache-2.0" interchangeably - left
        alone they produced three separate filter chips for one license, which
        reads as a bug.

        ONLY plain disjunctions are reordered. Anything containing AND, WITH, or
        parentheses has structure whose meaning depends on operand order or
        grouping, so it is returned untouched rather than risk misstating it.
    #>
    param([string]$Expr)
    if ([string]::IsNullOrWhiteSpace($Expr)) { return "UNKNOWN" }
    $e = $Expr.Trim()
    if ($e -match '[()]| AND | WITH ') { return $e }
    $parts = @($e -split '\s+OR\s+|/' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -le 1) { return $e }
    return (($parts | Sort-Object -Unique) -join " OR ")
}

# Obligation classes, most permissive first. The index IS the severity rank, so
# ordering the chips and combining operands both fall out of the array order.
$CLASS_LABELS = @("Public domain", "Permissive", "Weak copyleft", "Strong copyleft", "Unclassified")

function Get-IdRank {
    <# Severity rank of a single SPDX license id. #>
    param([string]$Id)
    # A trailing "WITH <exception>" only ever loosens the base license, so the
    # base id decides the class.
    $s = (($Id -split '\s+WITH\s+')[0]).Trim()
    switch -Regex ($s) {
        '^(CC0-1\.0|0BSD|Unlicense|MIT-0)$' { return 0 }
        '^(AGPL|SSPL)'                      { return 3 }
        '^GPL(-|$)'                         { return 3 }
        '^(LGPL|MPL-|EPL-|CDDL|MS-RL)'      { return 2 }
        '^(MIT|Apache-2\.0|BSD-|ISC|Zlib|Unicode|BSL-1\.0|Python-2\.0|libpng|Artistic-2\.0)' { return 1 }
        default { return 4 }
    }
}

function Get-LicenseClass {
    <#
        Collapse a whole SPDX expression to one obligation class.

        A DISJUNCTION is as permissive as its loosest operand, because the
        licensee elects which branch to take - "MIT OR LGPL-2.1" is a permissive
        dependency, since nothing forces you onto the LGPL side. An expression
        with AND / parentheses is the opposite: every operand's obligations apply
        at once, so the strictest one governs.
    #>
    param([string]$Expr)
    if ([string]::IsNullOrWhiteSpace($Expr) -or $Expr.Trim() -eq "UNKNOWN") { return 4 }
    $e = $Expr.Trim()
    $conservative = $e -match '[()]|\s+AND\s+'
    $ids = @($e -split '\s+OR\s+|\s+AND\s+|/|[()]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($ids.Count -eq 0) { return 4 }
    $ranks = @($ids | ForEach-Object { Get-IdRank $_ })
    if ($conservative) { return ($ranks | Measure-Object -Maximum).Maximum }
    return ($ranks | Measure-Object -Minimum).Minimum
}

function Get-LicenseClassLabel {
    param([string]$Expr)
    return $CLASS_LABELS[(Get-LicenseClass $Expr)]
}

function Read-LicenseFiles {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return $null }
    # COPYRIGHT covers the ring/unicode-ident style crates that keep the notice
    # out of LICENSE-*; NOTICE is the Apache-2.0 attribution file.
    $files = Get-ChildItem $Dir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)' } |
        Sort-Object Name
    if (-not $files) { return $null }
    $parts = foreach ($f in $files) {
        "----- $($f.Name) -----`n" + (Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue)
    }
    return ($parts -join "`n`n")
}

# ---------------------------------------------------------------- Rust crates
Write-Host "Collecting Rust crates from Cargo.lock..." -ForegroundColor Cyan

# cargo unpacks a crate into registry\src only when it actually compiles it, so
# a Windows build never unpacks the Linux/macOS half of the lock (gtk, glib,
# objc2, block2, ...). Reading licenses straight off whatever happens to be
# unpacked therefore gives a different document on a CI runner than on a dev
# machine, where rust-analyzer's constant `cargo metadata` has unpacked the lot
# - which surfaces as a bogus "out of date". `cargo metadata` resolves the graph
# for every target and unpacks all of it, so ask for that first. It also has to
# run before the enumeration below, because on a runner whose cache was restored
# with registry\src pruned the directory may not exist yet.
Write-Host "  unpacking crate sources (cargo metadata)..." -ForegroundColor DarkGray
& cargo metadata --format-version 1 --manifest-path (Join-Path $root "src-tauri\Cargo.toml") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "cargo metadata failed - cannot resolve crate sources" }

$registry = Join-Path $env:USERPROFILE ".cargo\registry\src"
$regDirs = @(Get-ChildItem $registry -Directory -ErrorAction SilentlyContinue)
if ($regDirs.Count -eq 0) {
    throw "cargo registry cache not found under $registry - run a build first so the sources are vendored locally"
}

$lock = Get-Content (Join-Path $root "src-tauri\Cargo.lock") -Raw

# Parse [[package]] blocks rather than scanning for name/version pairs, because
# the block is what tells local crates apart from third-party ones: a registry
# crate carries `source = "registry+https://..."`, a path/workspace crate has no
# `source` at all. Detecting it structurally means adding another local crate
# (exrthumb, psdcomp, ...) needs no edit here - hardcoding the names silently
# reports the next one as an UNKNOWN-licensed third-party dependency.
$crates = foreach ($block in ($lock -split '(?m)^\[\[package\]\]\s*$')) {
    if (-not $block.Trim()) { continue }
    $n = [regex]::Match($block, '(?m)^name = "([^"]+)"')
    $v = [regex]::Match($block, '(?m)^version = "([^"]+)"')
    if (-not ($n.Success -and $v.Success)) { continue }
    [pscustomobject]@{
        Name    = $n.Groups[1].Value
        Version = $v.Groups[1].Value
        IsLocal = -not [regex]::IsMatch($block, '(?m)^source = ')
    }
}

$missingLicense = New-Object System.Collections.ArrayList
$notUnpacked = New-Object System.Collections.ArrayList
$localNames = @($crates | Where-Object { $_.IsLocal } | ForEach-Object { $_.Name })
Write-Host "  local (not redistributed): $($localNames -join ', ')" -ForegroundColor DarkGray

foreach ($c in $crates) {
    if ($c.IsLocal) { continue }
    $dir = $null
    foreach ($rd in $regDirs) {
        $candidate = Join-Path $rd.FullName "$($c.Name)-$($c.Version)"
        if (Test-Path $candidate) { $dir = $candidate; break }
    }
    $license = "UNKNOWN"
    if ($dir) {
        $m = Select-String -Path (Join-Path $dir "Cargo.toml") -Pattern '^license\s*=\s*"(.+)"' -ErrorAction SilentlyContinue
        if ($m) { $license = $m.Matches[0].Groups[1].Value }
        else {
            $mf = Select-String -Path (Join-Path $dir "Cargo.toml") -Pattern '^license-file\s*=' -ErrorAction SilentlyContinue
            if ($mf) { $license = "see bundled license text" }
        }
    }
    $label = "$($c.Name) $($c.Version)"
    $norm = Format-License $license
    [void]$rows.Add([pscustomobject]@{
        Ecosystem = "Rust (crates.io)"; Name = $c.Name; Version = $c.Version
        License = $norm; Class = (Get-LicenseClassLabel $norm); Label = $label
    })
    if ($dir) {
        $txt = Read-LicenseFiles $dir
        if ($txt) { Add-LicenseText $label $txt }
        else { [void]$missingLicense.Add($label) }
    }
    else { [void]$notUnpacked.Add($label) }
}

# A crate whose source never got unpacked would otherwise be published as
# UNKNOWN with no license text - an attribution gap that looks like a stale
# file rather than the missing evidence it is. Refuse to generate instead.
if ($notUnpacked.Count -gt 0) {
    $notUnpacked | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    throw "$($notUnpacked.Count) crate(s) are in Cargo.lock but not unpacked under $registry - cannot read their licenses"
}

# ------------------------------------------------------------- npm production
Write-Host "Collecting npm production dependencies..." -ForegroundColor Cyan

Push-Location $root
try {
    # npm exits non-zero on benign peer-dep warnings, so read stdout regardless
    # and only fail if the payload is unusable.
    $lsJson = & npm ls --omit=dev --all --json --long 2>$null | Out-String
}
finally {
    Pop-Location
}

$npmPkgs = @{}
if ($lsJson.Trim()) {
    try { $tree = $lsJson | ConvertFrom-Json } catch { $tree = $null }
    if ($tree) {
        # Walk the dependency tree iteratively; npm nests arbitrarily deep and a
        # recursive PowerShell function would blow the pipeline depth on cycles.
        $stack = New-Object System.Collections.Stack
        $stack.Push($tree)
        while ($stack.Count -gt 0) {
            $node = $stack.Pop()
            if (-not $node.PSObject.Properties['dependencies']) { continue }
            foreach ($p in $node.dependencies.PSObject.Properties) {
                $dep = $p.Value
                if (-not $dep) { continue }
                $ver = $dep.version
                if (-not $ver) { continue }
                $key = "$($p.Name)@$ver"
                if (-not $npmPkgs.ContainsKey($key)) {
                    $npmPkgs[$key] = $dep
                    $stack.Push($dep)
                }
            }
        }
    }
}
if ($npmPkgs.Count -eq 0) {
    Write-Warning "npm ls returned nothing usable - falling back to scanning node_modules"
    $dirs = @(Get-ChildItem (Join-Path $root "node_modules") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike ".*" })
    $scoped = @($dirs | Where-Object { $_.Name -like "@*" } | ForEach-Object { Get-ChildItem $_.FullName -Directory })
    foreach ($d in (@($dirs | Where-Object { $_.Name -notlike "@*" }) + $scoped)) {
        $pj = Join-Path $d.FullName "package.json"
        if (-not (Test-Path $pj)) { continue }
        $j = Get-Content $pj -Raw | ConvertFrom-Json
        $npmPkgs["$($j.name)@$($j.version)"] = [pscustomobject]@{
            name = $j.name; version = $j.version; license = $j.license; path = $d.FullName
        }
    }
}

foreach ($key in ($npmPkgs.Keys | Sort-Object)) {
    $dep = $npmPkgs[$key]
    $name = $key -replace '@[^@]+$', ''
    $ver = $dep.version
    $lic = "UNKNOWN"
    if ($dep.PSObject.Properties['license'] -and $dep.license) {
        # npm allows license to be a string or a legacy { type, url } object.
        if ($dep.license -is [string]) { $lic = $dep.license }
        elseif ($dep.license.PSObject.Properties['type']) { $lic = $dep.license.type }
    }
    $dir = $null
    if ($dep.PSObject.Properties['path'] -and $dep.path) { $dir = $dep.path }
    if ((-not $dir) -or (-not (Test-Path $dir))) {
        $dir = Join-Path $root "node_modules\$name"
    }
    $label = "$name $ver"
    $txt = Read-LicenseFiles $dir
    # A package with no `license` field but a bundled MIT text IS MIT-licensed;
    # record the plain SPDX id rather than prose, so the field stays parseable.
    if ($lic -eq "UNKNOWN" -and $txt -match 'MIT License') { $lic = "MIT" }
    $normNpm = Format-License $lic
    [void]$rows.Add([pscustomobject]@{
        Ecosystem = "npm"; Name = $name; Version = $ver
        License = $normNpm; Class = (Get-LicenseClassLabel $normNpm); Label = $label
    })
    if ($txt) { Add-LicenseText $label $txt }
    else { [void]$missingLicense.Add("$label (npm)") }
}

# ------------------------------------------------------------- vendored source
# Checked into src/vendor/, so neither package manager reports it.
Write-Host "Collecting vendored sources..." -ForegroundColor Cyan
$vendorRoot = Join-Path $root "src\vendor"
if (Test-Path $vendorRoot) {
    foreach ($v in (Get-ChildItem $vendorRoot -Directory)) {
        $txt = Read-LicenseFiles $v.FullName
        $lic = "UNKNOWN"
        if ($txt -match 'MIT License') { $lic = "MIT" }
        elseif ($txt -match 'Apache License') { $lic = "Apache-2.0" }
        elseif ($txt -match 'GNU (GENERAL|AFFERO|LESSER)') { $lic = "GPL-family - REVIEW BEFORE SHIPPING" }
        $normV = Format-License $lic
        [void]$rows.Add([pscustomobject]@{
            Ecosystem = "vendored (src/vendor)"; Name = $v.Name; Version = "vendored"
            License = $normV; Class = (Get-LicenseClassLabel $normV); Label = "$($v.Name) (vendored)"
        })
        if ($txt) { Add-LicenseText "$($v.Name) (vendored)" $txt }
        else { [void]$missingLicense.Add("$($v.Name) (vendored, no license file)") }
    }
}

# ------------------------------------------------------------------- emit file
if ($Check) { Write-Host "Comparing against $outFile..." -ForegroundColor Cyan }
else { Write-Host "Writing $outFile..." -ForegroundColor Cyan }

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# Third-party licenses")
[void]$sb.AppendLine()
[void]$sb.AppendLine("Game Asset Browser bundles the open-source components listed below. Each is used")
[void]$sb.AppendLine("unmodified and remains under its own license; the full text of every distinct")
[void]$sb.AppendLine("license follows the summary table.")
[void]$sb.AppendLine()
[void]$sb.AppendLine("GENERATED FILE - do not edit by hand. Regenerate with ``npm run licenses``")
[void]$sb.AppendLine("(scripts/gen-third-party.ps1) whenever dependencies change.")
[void]$sb.AppendLine()

$sorted = $rows | Sort-Object Ecosystem, Name, Version
$byLicense = $sorted | Group-Object License | Sort-Object Count -Descending

[void]$sb.AppendLine("## Summary")
[void]$sb.AppendLine()
[void]$sb.AppendLine("By obligation class - a disjunction is classed by its loosest branch, since")
[void]$sb.AppendLine("the licensee elects which one to take; an AND expression by its strictest.")
[void]$sb.AppendLine()
[void]$sb.AppendLine("| Class | Components |")
[void]$sb.AppendLine("| --- | --- |")
foreach ($lbl in $CLASS_LABELS) {
    $n = @($sorted | Where-Object { $_.Class -eq $lbl }).Count
    if ($n -gt 0) { [void]$sb.AppendLine("| $lbl | $n |") }
}
[void]$sb.AppendLine()
[void]$sb.AppendLine("By declared license expression:")
[void]$sb.AppendLine()
[void]$sb.AppendLine("| License | Components |")
[void]$sb.AppendLine("| --- | --- |")
foreach ($g in $byLicense) {
    [void]$sb.AppendLine("| $($g.Name) | $($g.Count) |")
}
[void]$sb.AppendLine()
[void]$sb.AppendLine("Total components: $($sorted.Count)")
[void]$sb.AppendLine()
[void]$sb.AppendLine("MPL-2.0 components (symphonia and cssparser families) are used unmodified. Their")
[void]$sb.AppendLine("source is available from crates.io at the exact versions listed below, which is")
[void]$sb.AppendLine("what MPL-2.0 section 3.2 requires.")
[void]$sb.AppendLine()

[void]$sb.AppendLine("## Components")
[void]$sb.AppendLine()
[void]$sb.AppendLine("| Component | Version | License | Source |")
[void]$sb.AppendLine("| --- | --- | --- | --- |")
foreach ($r in $sorted) {
    [void]$sb.AppendLine("| $($r.Name) | $($r.Version) | $($r.License) | $($r.Ecosystem) |")
}
[void]$sb.AppendLine()

[void]$sb.AppendLine("## Full license texts")
[void]$sb.AppendLine()
$i = 0
foreach ($hash in $texts.Keys) {
    $i++
    $entry = $texts[$hash]
    $pkgs = ($entry.Packages | Sort-Object) -join ", "
    [void]$sb.AppendLine("### $i. $pkgs")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine($entry.Text)
    [void]$sb.AppendLine('```')
    [void]$sb.AppendLine()
}

if ($missingLicense.Count -gt 0) {
    [void]$sb.AppendLine("## Components with no bundled license file")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("These declare a license in their manifest but ship no license file. The SPDX id")
    [void]$sb.AppendLine("in the table above governs; the canonical text is the standard text of that license.")
    [void]$sb.AppendLine()
    foreach ($m in ($missingLicense | Sort-Object)) { [void]$sb.AppendLine("- $m") }
    [void]$sb.AppendLine()
}

$generated = $sb.ToString()

# ------------------------------------------------- structured data for the app
# The markdown above is the artifact a compliance reviewer reads. The About
# dialog needs something it can search and lay out, so emit the same data as
# JSON, split in two:
#
#   thirdParty.json      ~50 KB  - one row per component, loaded when the
#                                  Licenses tab is first opened.
#   thirdPartyTexts.json ~2 MB   - the deduped license texts, loaded only when
#                                  someone expands an individual component.
#
# Splitting matters: the previous build embedded all 2 MB in a single lazy
# chunk, so merely opening the attributions list paid for text nobody read.
$hashIndex = @{}
$i2 = 0
foreach ($h in $texts.Keys) { $hashIndex[$h] = $i2; $i2++ }

$components = foreach ($r in $sorted) {
    $ti = -1
    if ($r.Label -and $pkgTextHash.ContainsKey($r.Label)) { $ti = $hashIndex[$pkgTextHash[$r.Label]] }
    # Short keys: this ships in the binary, and `n/v/l/c/e/t` over 623 rows saves
    # more than it costs in readability for a generated file.
    [ordered]@{ n = $r.Name; v = $r.Version; l = $r.License; c = $r.Class; e = $r.Ecosystem; t = $ti }
}

# Chips group on the obligation class, not the raw SPDX string: five near-identical
# disjunctions answer "what exactly does this say", when the question a reader of
# that filter actually has is "does any of this create work for me". The exact
# expression stays on every row, so nothing is hidden.
# Iterating CLASS_LABELS keeps the chips in severity order without sorting on a
# computed key, which PS 5.1 mis-parses when the key is a static method call.
$byClass = foreach ($lbl in $CLASS_LABELS) {
    $n = @($sorted | Where-Object { $_.Class -eq $lbl }).Count
    if ($n -gt 0) { [pscustomobject]@{ Name = $lbl; Count = $n } }
}

$meta = [ordered]@{
    count      = $sorted.Count
    textCount  = $texts.Count
    classes    = @(foreach ($g in $byClass) { [ordered]@{ class = $g.Name; count = $g.Count } })
    summary    = @(foreach ($g in $byLicense) { [ordered]@{ license = $g.Name; count = $g.Count } })
    components = @($components)
}

$genDir = Join-Path $root "src\generated"
New-Item -ItemType Directory -Force -Path $genDir | Out-Null
$metaFile = Join-Path $genDir "thirdParty.json"
$textsFile = Join-Path $genDir "thirdPartyTexts.json"

$metaJson = $meta | ConvertTo-Json -Depth 6 -Compress
$textsJson = @(foreach ($h in $texts.Keys) { $texts[$h].Text }) | ConvertTo-Json -Depth 3 -Compress

function Test-Current {
    param([string]$File, [string]$Expected, [string]$Label)
    if (-not (Test-Path $File)) { throw "$Label is missing - run: npm run licenses" }
    # Compare on normalized line endings: git checkouts differ between runners
    # (CRLF on Windows, LF on Linux) and that is not a stale-attribution signal.
    $existing = (Get-Content $File -Raw) -replace "`r`n", "`n"
    $want = ($Expected -replace "`r`n", "`n")
    if ($existing.TrimEnd() -eq $want.TrimEnd()) { return }

    # "Out of date" on its own is unactionable when the mismatch only reproduces
    # on a runner - the answer is in *which* lines moved. Show the first few.
    $a = $existing.TrimEnd() -split "`n"
    $b = $want.TrimEnd() -split "`n"
    $clip = { param($s) if ($s.Length -gt 150) { $s.Substring(0, 150) + " [...]" } else { $s } }
    Write-Host ""
    Write-Host ("{0}: committed {1:N0} lines, generated {2:N0} lines" -f $Label, $a.Count, $b.Count) -ForegroundColor Yellow
    $shown = 0
    for ($i = 0; $i -lt [Math]::Max($a.Count, $b.Count) -and $shown -lt 8; $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { "<end of file>" }
        $y = if ($i -lt $b.Count) { $b[$i] } else { "<end of file>" }
        if ($x -eq $y) { continue }
        $shown++
        Write-Host "  line $($i + 1):" -ForegroundColor DarkGray
        Write-Host "    committed: $(& $clip $x)" -ForegroundColor Red
        Write-Host "    generated: $(& $clip $y)" -ForegroundColor Green
    }
    throw "$Label is out of date - run 'npm run licenses' and commit the result"
}

if ($Check) {
    Test-Current $outFile    $generated "THIRD-PARTY-LICENSES.md"
    Test-Current $metaFile   $metaJson  "src/generated/thirdParty.json"
    Test-Current $textsFile  $textsJson "src/generated/thirdPartyTexts.json"
    Write-Host ""
    Write-Host "Attributions are up to date ($($sorted.Count) components)." -ForegroundColor Green
}
else {
    $generated | Out-File -FilePath $outFile -Encoding utf8
    $metaJson  | Out-File -FilePath $metaFile -Encoding utf8
    $textsJson | Out-File -FilePath $textsFile -Encoding utf8
    Write-Host ""
    Write-Host "Wrote $($sorted.Count) components, $($texts.Count) distinct license texts." -ForegroundColor Green
    Write-Host ("  THIRD-PARTY-LICENSES.md      {0,7:N0} KB" -f ((Get-Item $outFile).Length / 1KB)) -ForegroundColor DarkGray
    Write-Host ("  src/generated/thirdParty.json      {0,7:N0} KB" -f ((Get-Item $metaFile).Length / 1KB)) -ForegroundColor DarkGray
    Write-Host ("  src/generated/thirdPartyTexts.json {0,7:N0} KB" -f ((Get-Item $textsFile).Length / 1KB)) -ForegroundColor DarkGray
}

# Fail loudly on anything that would block a commercial release, rather than
# burying it in the generated file.
$blocking = $sorted | Where-Object {
    $_.License -match 'GPL|AGPL|SSPL|CC-BY-NC|Commons-Clause|PolyForm|REVIEW BEFORE SHIPPING' -and
    $_.License -notmatch 'LGPL-2\.1-or-later$|OR MIT|OR Apache'
}
if ($blocking) {
    Write-Host ""
    Write-Warning "Components with copyleft/noncommercial terms - review before selling:"
    $blocking | ForEach-Object { Write-Host "  $($_.Name) $($_.Version): $($_.License)" -ForegroundColor Yellow }
}
$unknown = $sorted | Where-Object { $_.License -eq "UNKNOWN" }
if ($unknown) {
    Write-Host ""
    Write-Warning "Components with no declared license - resolve before selling:"
    $unknown | ForEach-Object { Write-Host "  $($_.Name) $($_.Version) [$($_.Ecosystem)]" -ForegroundColor Yellow }
}
