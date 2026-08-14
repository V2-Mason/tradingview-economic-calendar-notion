#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipMoomoo,
    [switch]$SkipYahoo,
    [switch]$SkipNews,
    [switch]$PublishNotion,
    [ValidateSet("auto", "required", "off")]
    [string]$SecMode = "auto",
    [ValidateRange(1, 10080)]
    [int]$FreshnessMinutes = 180,
    [ValidateRange(1, 65535)]
    [int]$OpenDPort = 11111,
    [ValidateNotNullOrEmpty()]
    [string]$OpenDAddress = "127.0.0.1",
    [ValidateRange(100, 30000)]
    [int]$OpenDTimeoutMilliseconds = 1500,
    [string]$NodePath = "",
    [string]$PythonPath = "",
    [string]$NotionConfigPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:PrivateRoot = [System.IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot ".private"))
$script:WatchlistPath = Join-Path $script:PrivateRoot "watchlist.json"
$script:LogFile = $null
$script:MutexName = "Local\TradingViewEconomicCalendarPrivateUpdate-v1"

function Write-RunLog {
    param(
        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level,
        [string]$Message
    )

    $line = "{0} [{1}] {2}" -f [DateTimeOffset]::UtcNow.ToString("o"), $Level, $Message
    Write-Host $line
    if ($null -ne $script:LogFile) {
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    }
}

function Get-CommandPath {
    param([string]$Preferred, [string[]]$FallbackNames)

    if ($Preferred) {
        if (Test-Path -LiteralPath $Preferred -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($Preferred)
        }
        $preferredCommand = Get-Command $Preferred -ErrorAction SilentlyContinue
        if ($null -ne $preferredCommand) { return $preferredCommand.Source }
        return $null
    }

    foreach ($name in $FallbackNames) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }
    return $null
}

function Resolve-PrivatePath {
    param([string]$Value, [string]$DefaultPath)

    $candidate = if ($Value) {
        if ([System.IO.Path]::IsPathRooted($Value)) { $Value } else { Join-Path $script:RepositoryRoot $Value }
    }
    else {
        $DefaultPath
    }
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    $privatePrefix = $script:PrivateRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if (
        $resolved -ne $script:PrivateRoot -and
        -not $resolved.StartsWith($privatePrefix, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "Private configuration must remain under $script:PrivateRoot"
    }
    return $resolved
}

function Test-OpenDEndpoint {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($OpenDAddress, $OpenDPort, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne($OpenDTimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($result)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Invoke-ExternalStage {
    param(
        [string]$Stage,
        [string]$Executable,
        [string[]]$Arguments
    )

    Write-RunLog INFO "Starting $Stage."
    $lines = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in @($lines)) {
        Write-RunLog INFO ("{0}: {1}" -f $Stage, [string]$line)
    }
    if ($exitCode -ne 0) {
        Write-RunLog WARN "$Stage failed with exit code $exitCode."
    }
    else {
        Write-RunLog INFO "$Stage completed."
    }
    return $exitCode
}

function Get-StagingState {
    param(
        [string]$Path,
        [string]$ExpectedPolicy,
        [ValidateSet("events", "news")]
        [string]$CollectionProperty
    )

    $state = [ordered]@{
        Path = $Path
        Exists = $false
        Valid = $false
        Fresh = $false
        GeneratedAt = $null
        AgeMinutes = $null
        Items = 0
        Errors = 0
        Reason = "missing"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]$state
    }

    $state.Exists = $true
    try {
        $document = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($document.schemaVersion -ne "1.0.0") { throw "unsupported schemaVersion" }
        if ($document.dataPolicy -ne $ExpectedPolicy) { throw "unexpected dataPolicy" }
        $collection = $document.PSObject.Properties[$CollectionProperty]
        if ($null -eq $collection) { throw "$CollectionProperty array is missing" }
        $items = @($collection.Value)
        foreach ($item in $items) {
            $required = if ($CollectionProperty -eq "events") {
                @("id", "market", "ticker", "scheduledAt")
            }
            else {
                @("id", "market", "ticker", "title", "url", "verificationStatus", "fetchedAt")
            }
            foreach ($field in $required) {
                if ($null -eq $item.PSObject.Properties[$field]) {
                    throw "a $CollectionProperty item lacks $field"
                }
            }
            if ($CollectionProperty -eq "news" -and $item.verificationStatus -ne "UNVERIFIED") {
                throw "a company-news item is not marked UNVERIFIED"
            }
        }
        $generatedAt = [DateTimeOffset]::Parse(
            [string]$document.generatedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $ageMinutes = ([DateTimeOffset]::UtcNow - $generatedAt.ToUniversalTime()).TotalMinutes
        $errors = 0
        if ($null -ne $document.PSObject.Properties["collectionErrors"]) {
            $errors = @($document.collectionErrors).Count
        }

        $state.Valid = $true
        $state.GeneratedAt = $generatedAt.ToString("o")
        $state.AgeMinutes = [Math]::Round($ageMinutes, 1)
        $state.Items = $items.Count
        $state.Errors = $errors
        if ($ageMinutes -lt -5) {
            $state.Reason = "generatedAt is more than five minutes in the future"
        }
        elseif ($ageMinutes -gt $FreshnessMinutes) {
            $state.Reason = "snapshot exceeds the $FreshnessMinutes minute freshness limit"
        }
        else {
            $state.Fresh = $true
            $state.Reason = if ($errors -gt 0) { "fresh with partial errors" } else { "fresh" }
        }
    }
    catch {
        $state.Reason = $_.Exception.Message
    }
    return [pscustomobject]$state
}

function Write-SnapshotState {
    param([string]$Provider, $State)
    $age = if ($null -eq $State.AgeMinutes) { "n/a" } else { "{0}m" -f $State.AgeMinutes }
    Write-RunLog INFO (
        "{0} snapshot: exists={1}, valid={2}, fresh={3}, age={4}, items={5}, errors={6}, reason={7}" -f
        $Provider, $State.Exists, $State.Valid, $State.Fresh, $age, $State.Items, $State.Errors, $State.Reason
    )
}

function Publish-AtomicFile {
    param(
        [string]$Candidate,
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        throw "Atomic publish candidate is missing: $Candidate"
    }
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $backup = "$Destination.previous"
        if (Test-Path -LiteralPath $backup) {
            [System.IO.File]::Delete($backup)
        }
        [System.IO.File]::Replace($Candidate, $Destination, $backup, $true)
    }
    else {
        [System.IO.File]::Move($Candidate, $Destination)
    }
}

function Test-HtmlCandidate {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "HTML candidate is missing" }
    if ((Get-Item -LiteralPath $Path).Length -lt 1024) { throw "HTML candidate is unexpectedly small" }
    $html = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ($html -notmatch "window\.__EARNINGS_SOURCE_CATALOG__=") {
        throw "HTML candidate lacks the embedded source catalog"
    }
    if ($html -notmatch "connect-src 'none'") { throw "HTML candidate lacks the offline CSP" }
    if ($html -match '<script\b[^>]*\bsrc=') { throw "HTML candidate has an external script" }
    if ($html -match '<link\b[^>]*rel=["'']stylesheet["'']') {
        throw "HTML candidate has an external stylesheet"
    }
}

function Invoke-Updater {
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $script:PrivateRoot -Force | Out-Null
        $logDirectory = Join-Path $script:PrivateRoot "logs"
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $script:LogFile = Join-Path $logDirectory ("update-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
    }

    $node = Get-CommandPath -Preferred $NodePath -FallbackNames @("node")
    $python = Get-CommandPath -Preferred $PythonPath -FallbackNames @("py", "python")
    $moomooScript = Join-Path $script:RepositoryRoot "scripts\fetch_moomoo_earnings.py"
    $yahooScript = Join-Path $script:RepositoryRoot "scripts\fetch_yahoo_quote_summary.mjs"
    $newsScript = Join-Path $script:RepositoryRoot "scripts\fetch_company_news.py"
    $builderScript = Join-Path $script:RepositoryRoot "scripts\build_notion_earnings.mjs"
    $notionEarningsScript = Join-Path $script:RepositoryRoot "scripts\sync_notion_earnings.mjs"
    $notionNewsScript = Join-Path $script:RepositoryRoot "scripts\sync_notion_company_news.mjs"
    $notionNewsWidgetScript = Join-Path $script:RepositoryRoot "scripts\sync_notion_news_widget.mjs"
    $moomooFinal = Join-Path $script:PrivateRoot "moomoo-earnings-staging.json"
    $yahooFinal = Join-Path $script:PrivateRoot "yahoo-earnings-staging.json"
    $newsFinal = Join-Path $script:PrivateRoot "company-news-staging.json"
    $htmlFinal = Join-Path $script:PrivateRoot "notion-earnings-calendar.html"
    $notionConfig = Resolve-PrivatePath $NotionConfigPath (Join-Path $script:PrivateRoot "notion-sync.json")

    if ($null -eq $node) {
        Write-RunLog ERROR "Node.js is required for Yahoo collection and the private HTML build."
        return 1
    }
    if (-not (Test-Path -LiteralPath $script:WatchlistPath -PathType Leaf)) {
        Write-RunLog ERROR "Private watchlist is missing: $script:WatchlistPath"
        return 1
    }
    foreach ($requiredFile in @($moomooScript, $yahooScript, $newsScript, $builderScript)) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            Write-RunLog ERROR "Required script is missing: $requiredFile"
            return 1
        }
    }

    $initialMoomoo = Get-StagingState $moomooFinal "MOOMOO_PERSONAL_STAGING_ONLY" "events"
    $initialYahoo = Get-StagingState $yahooFinal "YAHOO_PERSONAL_STAGING_ONLY" "events"
    $initialNews = Get-StagingState $newsFinal "PRIVATE_PERSONAL_STAGING_ONLY" "news"
    Write-SnapshotState "Moomoo current" $initialMoomoo
    Write-SnapshotState "Yahoo current" $initialYahoo
    Write-SnapshotState "Company news current" $initialNews

    if ($DryRun) {
        Write-RunLog INFO "DRY RUN: no network request, file write, mutex acquisition, or Scheduled Task change will occur."
        Write-RunLog INFO "DRY RUN: Moomoo would preflight ${OpenDAddress}:$OpenDPort and run independently when available."
        Write-RunLog INFO "DRY RUN: Yahoo would run independently with Node.js."
        Write-RunLog INFO "DRY RUN: company news would run independently when Python and OpenD are available; SEC mode is $SecMode."
        Write-RunLog INFO "DRY RUN: fresh candidates would be atomically promoted, then a temporary self-contained HTML would be validated and atomically published."
        if ($PublishNotion) {
            Write-RunLog INFO "DRY RUN: -PublishNotion was requested, but no Notion command or external write will run."
        }
        if ($null -eq $python -and (-not $SkipMoomoo -or -not $SkipNews)) {
            Write-RunLog WARN "DRY RUN: no Python launcher was found; Moomoo and/or company news would be skipped."
        }
        return 0
    }

    $mutex = New-Object System.Threading.Mutex($false, $script:MutexName)
    $hasMutex = $false
    $runId = "{0}-{1}" -f [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ"), $PID
    $moomooCandidate = Join-Path $script:PrivateRoot "moomoo-$runId.candidate.json"
    $yahooCandidate = Join-Path $script:PrivateRoot "yahoo-$runId.candidate.json"
    $newsCandidate = Join-Path $script:PrivateRoot "company-news-$runId.candidate.json"
    $htmlCandidate = Join-Path $script:PrivateRoot "notion-earnings-$runId.candidate.html"
    $missingMoomoo = Join-Path $script:PrivateRoot "missing-moomoo-$runId.json"
    $missingYahoo = Join-Path $script:PrivateRoot "missing-yahoo-$runId.json"
    $candidatePaths = @($moomooCandidate, $yahooCandidate, $newsCandidate, $htmlCandidate)

    try {
        try {
            $hasMutex = $mutex.WaitOne(0, $false)
        }
        catch [System.Threading.AbandonedMutexException] {
            $hasMutex = $true
            Write-RunLog WARN "Recovered an abandoned updater mutex."
        }
        if (-not $hasMutex) {
            Write-RunLog WARN "Another private earnings update is already running; this run is skipped."
            return 2
        }

        Write-RunLog INFO "Private earnings and company-news update $runId started."
        $updatedEarningsProviders = New-Object System.Collections.Generic.List[string]
        $newsUpdated = $false
        $openDAvailable = $false
        if ($null -ne $python -and (-not $SkipMoomoo -or -not $SkipNews)) {
            $openDAvailable = Test-OpenDEndpoint
            if ($openDAvailable) {
                Write-RunLog INFO "OpenD preflight passed at ${OpenDAddress}:$OpenDPort."
            }
            else {
                Write-RunLog WARN "OpenD is not reachable at ${OpenDAddress}:$OpenDPort."
            }
        }

        if ($SkipMoomoo) {
            Write-RunLog INFO "Moomoo collection was explicitly skipped."
        }
        elseif ($null -eq $python) {
            Write-RunLog WARN "No Python launcher was found; existing Moomoo snapshot is preserved."
        }
        elseif (-not $openDAvailable) {
            Write-RunLog WARN "OpenD is not reachable at ${OpenDAddress}:$OpenDPort; existing Moomoo snapshot is preserved."
        }
        else {
            $moomooExit = Invoke-ExternalStage "Moomoo collection" $python @(
                $moomooScript,
                "--watchlist", $script:WatchlistPath,
                "--output", $moomooCandidate,
                "--host", $OpenDAddress,
                "--port", [string]$OpenDPort
            )
            if ($moomooExit -eq 0) {
                $candidateState = Get-StagingState $moomooCandidate "MOOMOO_PERSONAL_STAGING_ONLY" "events"
                Write-SnapshotState "Moomoo candidate" $candidateState
                if ($candidateState.Valid -and $candidateState.Fresh) {
                    Publish-AtomicFile $moomooCandidate $moomooFinal
                    [void]$updatedEarningsProviders.Add("Moomoo")
                    Write-RunLog INFO "Moomoo snapshot was atomically promoted."
                }
                else {
                    Write-RunLog WARN "Moomoo candidate failed the freshness gate; existing snapshot is preserved."
                }
            }
        }

        if ($SkipYahoo) {
            Write-RunLog INFO "Yahoo collection was explicitly skipped."
        }
        else {
            $yahooExit = Invoke-ExternalStage "Yahoo collection" $node @(
                $yahooScript,
                "--watchlist", $script:WatchlistPath,
                "--output", $yahooCandidate
            )
            if ($yahooExit -eq 0) {
                $candidateState = Get-StagingState $yahooCandidate "YAHOO_PERSONAL_STAGING_ONLY" "events"
                Write-SnapshotState "Yahoo candidate" $candidateState
                if ($candidateState.Valid -and $candidateState.Fresh) {
                    Publish-AtomicFile $yahooCandidate $yahooFinal
                    [void]$updatedEarningsProviders.Add("Yahoo")
                    Write-RunLog INFO "Yahoo snapshot was atomically promoted."
                }
                else {
                    Write-RunLog WARN "Yahoo candidate failed the freshness gate; existing snapshot is preserved."
                }
            }
        }

        if ($SkipNews) {
            Write-RunLog INFO "Company-news collection was explicitly skipped."
        }
        elseif ($null -eq $python) {
            Write-RunLog WARN "No Python launcher was found; existing company-news snapshot is preserved."
        }
        elseif (-not $openDAvailable) {
            Write-RunLog WARN "Company-news collection requires loopback OpenD; existing snapshot is preserved."
        }
        else {
            $newsExit = Invoke-ExternalStage "Company-news collection" $python @(
                $newsScript,
                "--watchlist", $script:WatchlistPath,
                "--output", $newsCandidate,
                "--host", $OpenDAddress,
                "--port", [string]$OpenDPort,
                "--sec-mode", $SecMode
            )
            if ($newsExit -eq 0) {
                $candidateState = Get-StagingState $newsCandidate "PRIVATE_PERSONAL_STAGING_ONLY" "news"
                Write-SnapshotState "Company news candidate" $candidateState
                if ($candidateState.Valid -and $candidateState.Fresh) {
                    Publish-AtomicFile $newsCandidate $newsFinal
                    $newsUpdated = $true
                    Write-RunLog INFO "Company-news snapshot was atomically promoted."
                }
                else {
                    Write-RunLog WARN "Company-news candidate failed the freshness gate; existing snapshot is preserved."
                }
            }
        }

        if ($updatedEarningsProviders.Count -eq 0 -and -not $newsUpdated) {
            Write-RunLog ERROR "No collector produced a promotable snapshot; existing snapshots and HTML are preserved."
            return 1
        }

        if ($updatedEarningsProviders.Count -gt 0) {
            $moomooState = Get-StagingState $moomooFinal "MOOMOO_PERSONAL_STAGING_ONLY" "events"
            $yahooState = Get-StagingState $yahooFinal "YAHOO_PERSONAL_STAGING_ONLY" "events"
            Write-SnapshotState "Moomoo final" $moomooState
            Write-SnapshotState "Yahoo final" $yahooState
            if (-not $moomooState.Fresh -and -not $yahooState.Fresh) {
                Write-RunLog ERROR "No valid earnings snapshot passed the freshness gate; existing HTML is preserved."
                return 1
            }

            $moomooInput = if ($moomooState.Valid) { $moomooFinal } else { $missingMoomoo }
            $yahooInput = if ($yahooState.Valid) { $yahooFinal } else { $missingYahoo }
            $buildExit = Invoke-ExternalStage "Private HTML build" $node @(
                $builderScript,
                "--moomoo", $moomooInput,
                "--yahoo", $yahooInput,
                "--output", $htmlCandidate,
                "--max-age-minutes", [string]$FreshnessMinutes
            )
            if ($buildExit -ne 0) {
                Write-RunLog ERROR "Private HTML build failed; existing HTML is preserved."
                return 1
            }

            Test-HtmlCandidate $htmlCandidate
            $candidateHash = (Get-FileHash -LiteralPath $htmlCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
            Publish-AtomicFile $htmlCandidate $htmlFinal
            $publishedHash = (Get-FileHash -LiteralPath $htmlFinal -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($candidateHash -ne $publishedHash) {
                throw "Published HTML hash does not match the validated candidate"
            }
            Write-RunLog INFO (
                "Private HTML was atomically published; providers={0}; sha256={1}." -f
                ($updatedEarningsProviders -join ","), $publishedHash
            )
        }
        else {
            Write-RunLog INFO "No earnings source was promoted; the existing private HTML was preserved."
        }

        if ($PublishNotion) {
            if (-not (Test-Path -LiteralPath $notionConfig -PathType Leaf)) {
                Write-RunLog ERROR "Notion publishing was requested but the private config is missing: $notionConfig"
                return 1
            }
            if ($updatedEarningsProviders.Count -gt 0) {
                if (-not (Test-Path -LiteralPath $notionEarningsScript -PathType Leaf)) {
                    Write-RunLog ERROR "Notion earnings sync script is missing: $notionEarningsScript"
                    return 1
                }
                $syncExit = Invoke-ExternalStage "Notion earnings sync" $node @(
                    $notionEarningsScript,
                    "--config", $notionConfig,
                    "--apply",
                    "--json"
                )
                if ($syncExit -ne 0) {
                    Write-RunLog ERROR "Notion earnings sync failed; local artifacts remain available for retry."
                    return 1
                }
            }
            if ($newsUpdated) {
                if (-not (Test-Path -LiteralPath $notionNewsScript -PathType Leaf)) {
                    Write-RunLog ERROR "Notion company-news sync was requested but its script is missing: $notionNewsScript"
                    return 1
                }
                $syncExit = Invoke-ExternalStage "Notion company-news sync" $node @(
                    $notionNewsScript,
                    "--config", $notionConfig,
                    "--apply",
                    "--json"
                )
                if ($syncExit -ne 0) {
                    Write-RunLog ERROR "Notion company-news sync failed; the local snapshot remains available for retry."
                    return 1
                }
            }
            if (-not (Test-Path -LiteralPath $notionNewsWidgetScript -PathType Leaf)) {
                Write-RunLog ERROR "Notion news-widget sync was requested but its script is missing: $notionNewsWidgetScript"
                return 1
            }
            $syncExit = Invoke-ExternalStage "Notion news-widget sync" $node @(
                $notionNewsWidgetScript,
                "--config", $notionConfig,
                "--apply",
                "--json"
            )
            if ($syncExit -ne 0) {
                Write-RunLog ERROR "Notion news-widget sync failed; the existing embed remains available for retry."
                return 1
            }
        }
        Write-RunLog INFO "Private earnings and company-news update $runId completed successfully."
        return 0
    }
    catch {
        Write-RunLog ERROR $_.Exception.Message
        return 1
    }
    finally {
        foreach ($candidate in $candidatePaths) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                [System.IO.File]::Delete($candidate)
            }
        }
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

exit (Invoke-Updater)
