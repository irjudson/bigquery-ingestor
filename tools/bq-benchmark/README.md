# bq-benchmark

BigQuery to Harper throughput benchmarking tool.

## Overview

Measures sustained throughput from BigQuery to Harper with:
- Three-phase benchmark (warmup, measurement, cooldown)
- Dual metrics: checkpoint-based (ingestion) + table-based (query availability)
- Sliding window measurement that excludes startup/consistency artifacts
- Comprehensive reporting with graphs

## Installation

```bash
cd tools/bq-benchmark
npm install
```

## Usage

### Basic Commands

```bash
# Show help
node cli.js --help

# Setup and verify connectivity
node cli.js setup --verify

# Run benchmark (default: 2min warmup, 5min measurement, 1min cooldown)
node cli.js run

# Run with custom timing
node cli.js run --warmup 300 --measure 900 --cooldown 120

# Generate all report formats
node cli.js run --json --csv

# Analyze previous run
node cli.js analyze benchmark-report-20260109-102315.json

# Cleanup test data
node cli.js cleanup
```

### Command Details

#### setup

Prepares the environment for benchmarking.

```bash
node cli.js setup [options]

Options:
  --vessels <number>  Number of vessels to generate (default: 100000)
  --dataset <name>    BigQuery dataset name (default: maritime_tracking)
  --skip-cleanup      Don't clean up existing benchmark data
  --verify            Verify BigQuery and Harper connectivity
```

#### run

Executes the three-phase benchmark.

```bash
node cli.js run [options]

Timing:
  --warmup <seconds>      Warmup phase duration (default: 120)
  --measure <seconds>     Measurement phase duration (default: 300)
  --cooldown <seconds>    Cooldown phase duration (default: 60)
  --sample-interval <s>   Checkpoint sampling interval (default: 5)

Output:
  --output <format>       Display format: live|logs (default: live)
  --report-file <path>    Report filename
  --json                  Also generate JSON report
  --csv                   Also generate CSV files
  --no-graphs             Disable ASCII graphs in markdown

Tables:
  --tables <ids>          Comma-separated table IDs to benchmark

Advanced:
  --skip-warmup           Skip warmup phase (debugging only)
  --profile               Enable resource profiling
  --verbose               Enable detailed logging
```

#### analyze

Analyzes a previous benchmark run.

```bash
node cli.js analyze <report-file> [options]

Options:
  --compare <file2>       Compare two benchmark runs
  --format <type>         Output format: json|csv|markdown (default: markdown)
  --percentiles <list>    Latency percentiles to calculate (default: 50,95,99)
```

#### cleanup

Removes benchmark data.

```bash
node cli.js cleanup [options]

Options:
  --bigquery              Delete BigQuery test data
  --harper                Delete Harper test data
  --all                   Delete both BigQuery and Harper data (default)
  --keep-reports          Don't delete benchmark report files
```

## Configuration

Uses the main project's `config.yaml`. Required sections:

```yaml
bigquery:
  projectId: your-project
  credentials: service-account-key.json
  location: US
  tables:
    - id: vessel_positions
      dataset: maritime_tracking
      table: vessel_positions
      timestampColumn: timestamp
      targetTable: VesselPositions
      # ... more tables

operations:
  host: localhost
  port: 9925
  username: admin
  password: your-password
```

## Output

**Default output:** Markdown report with ASCII graphs saved to `benchmark-report-{timestamp}.md`

**Optional formats:**
- `--json`: JSON report for programmatic access
- `--csv`: CSV files for spreadsheet analysis
- `--output logs`: Structured logs for monitoring systems

## Development Status

**MVP: ✅ Complete**

The tool is functional and can run benchmarks with basic reporting!

**Implemented:**
- ✅ Phase 1: Core Infrastructure (CLI, config, validation, checkpoint client)
- ✅ Phase 2: Metrics Collection (metrics collector, sliding window, resource monitor)
- ✅ Phase 3: Phase Management (phase manager, benchmark runner)
- ✅ Phase 4: Reporting (Markdown reporter with dual metrics)

**What Works:**
- Three-phase benchmark execution (warmup, measurement, cooldown)
- Dual metrics: checkpoint-based (ingestion) + table-based (query availability)
- Replication lag calculation
- Markdown report generation with statistics
- JSON report export
- Resource profiling (CPU, memory)

**Coming Soon:**
- Live dashboard with real-time updates
- CSV report export
- ASCII graphs in Markdown
- `analyze` and `cleanup` commands
- Comprehensive unit tests

## Architecture

```
tools/bq-benchmark/
├── cli.js              # Main CLI entry point
├── commands/           # Command implementations
│   ├── setup.js
│   ├── run.js
│   ├── analyze.js
│   └── cleanup.js
├── lib/                # Core modules
│   ├── benchmark-runner.js
│   ├── metrics-collector.js
│   ├── phase-manager.js
│   ├── checkpoint-client.js
│   ├── sliding-window.js
│   └── resource-monitor.js
├── reporters/          # Output formatters
│   ├── live-dashboard.js
│   ├── markdown-reporter.js
│   ├── json-reporter.js
│   └── csv-reporter.js
└── utils/              # Utilities
    ├── config-loader.js
    └── validation.js
```

## License

Apache 2.0
