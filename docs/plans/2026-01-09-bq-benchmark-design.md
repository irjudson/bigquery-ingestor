# BigQuery Ingestor Benchmarking Tool Design

**Date:** 2026-01-09
**Status:** Design Approved
**Version:** 1.1

## Executive Summary

This document outlines the design for `bq-benchmark`, a CLI tool that measures sustained throughput from BigQuery to Harper under realistic conditions. The tool addresses key challenges: BigQuery free tier limitations, Harper's eventual consistency, and the need to measure stable performance while excluding startup and cooldown latency.

**Key Features:**
- Three-phase benchmark (warmup, measurement, cooldown) with configurable timing
- Sliding window measurement that excludes startup/consistency artifacts
- Dual metrics: checkpoint-based (ingestion speed) + table-based (query availability)
- Measures complete pipeline: BigQuery → Harper ingestion → cluster replication
- Comprehensive metrics: records/min, MB/min, latency percentiles, resource utilization
- Live terminal dashboard with Markdown reports featuring ASCII graphs
- Multiple output formats: Markdown (default), JSON, CSV, structured logs

---

## 1. Overview and Architecture

### Purpose

The BigQuery Ingestor Benchmarking Tool (`bq-benchmark`) measures maximum sustained throughput from BigQuery to Harper, providing high-quality performance data for capacity planning and optimization.

### Core Architecture

The benchmark operates in three distinct phases:

1. **Warmup Phase** - Initializes the sync engine, lets Harper reach eventual consistency, and allows batch sizing to stabilize
2. **Measurement Phase** - Collects throughput metrics during stable operation
3. **Cooldown Phase** - Ensures all pending operations complete before calculating final metrics

### Data Flow

```
┌──────────────────┐
│   Maritime       │  Generates controlled
│   Synthesizer    │  high-volume test data
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│    BigQuery      │  Stores test data
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Harper Sync     │  Ingests via distributed
│    Engines       │  workload partitioning
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  SyncCheckpoint  │◄─── bq-benchmark samples
│     Table        │     every 5 seconds
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  Metrics         │  Calculates throughput,
│  Calculation     │  latency, resources
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Report          │  Markdown + graphs
│  Generation      │  (JSON/CSV optional)
└──────────────────┘
```

### Key Design Decisions

**Dual metric measurement:**
Tracks both checkpoint-based (ingestion speed) and table-based (query availability) metrics to provide a complete picture of system performance. The difference between these measurements reveals Harper's replication performance.

**Checkpoint-based measurement (primary):**
Tracks the authoritative SyncCheckpoint table to measure ingestion throughput. Checkpoints are updated synchronously by the sync engine and reflect exact ingestion progress without replication delays.

**Table-based measurement (secondary):**
Queries actual data tables to measure when records become queryable across the cluster. This reflects real user experience and validates checkpoint accuracy.

**Configurable timing:**
Users control warmup, measurement, and cooldown durations via CLI flags with sensible defaults (2min warmup, 5min measurement, 1min cooldown).

**Comprehensive metrics:**
Captures records/min, MB/min, latency percentiles (P50/P95/P99), resource utilization (CPU, memory, network), and replication lag in a single benchmark run.

**Sliding window algorithm:**
Measures throughput only during the measurement phase by calculating the difference in checkpoint values, naturally excluding startup and eventual consistency latency.

---

## 2. Benchmark Phases and Sliding Window Algorithm

### Phase Timing Configuration

```bash
bq-benchmark run --warmup 120 --measure 300 --cooldown 60
# Defaults: 2min warmup, 5min measurement, 1min cooldown
```

### Phase 1: Warmup (Default: 2 minutes)

**Purpose:** Stabilize the system before measurement begins

**Actions:**
- Start maritime synthesizer generating data at target rate
- Start Harper sync engine(s) ingesting from BigQuery
- Allow the sync engine to transition through initial → catchup → steady phases
- Let Harper's replication and eventual consistency settle
- Discard all metrics from this phase

**Why needed:**
- Initial phase uses larger batch sizes for catch-up
- First BigQuery queries may have cold-start latency
- Harper replication takes time to propagate across cluster
- TCP connections warm up, DNS caches populate

### Phase 2: Measurement (Default: 5 minutes)

**Purpose:** Capture stable throughput metrics

**Sample collection:**
Sample checkpoints at regular intervals (default: every 5 seconds)

```javascript
// Checkpoint sample structure
{
  timestamp: '2026-01-09T10:23:15Z',
  checkpoints: [
    { nodeId: 'node1-0', tableId: 'vessel_positions', lastTimestamp: '...', recordsIngested: 125000 },
    { nodeId: 'node2-0', tableId: 'vessel_positions', lastTimestamp: '...', recordsIngested: 123000 },
    { nodeId: 'node3-0', tableId: 'vessel_positions', lastTimestamp: '...', recordsIngested: 124500 }
  ],
  totalRecords: 372500,
  totalBytes: 93125000
}
```

**Instantaneous throughput calculation:**
Between consecutive samples:
- **Records/min** = Δ(total recordsIngested) / Δ(time in minutes)
- **MB/min** = Δ(total bytes) / Δ(time in minutes)
- **Latency** = (current time) - (lastTimestamp from BigQuery)

Store all samples for later analysis and percentile calculations.

### Phase 3: Cooldown (Default: 1 minute)

**Purpose:** Ensure completion and calculate final metrics

**Actions:**
- Stop data generation (or mark cutoff timestamp)
- Allow sync engines to finish processing queued batches
- Capture final checkpoint state
- Calculate aggregate statistics from measurement phase samples
- Verify all expected records were ingested

### Sliding Window Algorithm

The key insight is that we measure throughput **only during the measurement phase** by taking the difference in checkpoint values:

```javascript
// Pseudocode
measurementSamples = samples.filter(s => s.phase === 'measurement')
firstSample = measurementSamples[0]
lastSample = measurementSamples[measurementSamples.length - 1]

totalRecords = lastSample.totalRecords - firstSample.totalRecords
totalBytes = lastSample.totalBytes - firstSample.totalBytes
durationMinutes = (lastSample.timestamp - firstSample.timestamp) / 60000

avgRecordsPerMin = totalRecords / durationMinutes
avgMBPerMin = (totalBytes / (1024 * 1024)) / durationMinutes
```

This naturally excludes startup and eventual consistency latency because we're measuring the steady-state middle section.

**Benefits:**
- ✓ Avoids BigQuery cold-start latency
- ✓ Excludes Harper eventual consistency delays
- ✓ Measures only steady-state performance
- ✓ Compatible with BigQuery free tier (no billing surprises)
- ✓ Provides stable, reproducible measurements

---

## 3. CLI Design and Commands

### Binary Name

`bq-benchmark`

### Command Structure

```bash
bq-benchmark <command> [options]
```

### Commands

#### 3.1 `bq-benchmark setup`

Prepares the environment for benchmarking.

```bash
bq-benchmark setup [options]

Options:
  --vessels <number>      Number of vessels to generate (default: 100000)
  --dataset <name>        BigQuery dataset name (default: maritime_tracking)
  --skip-cleanup          Don't clean up existing benchmark data
  --verify                Verify BigQuery and Harper connectivity
```

**Actions:**
- Validates BigQuery credentials and permissions
- Validates Harper connectivity (Operations API, REST API)
- Optionally clears existing benchmark data in BigQuery
- Pre-generates initial dataset via maritime synthesizer
- Creates or verifies Harper tables exist
- Displays estimated costs (BigQuery storage, streaming API if enabled)

**Example output:**

```
✓ BigQuery authentication verified
✓ Harper connectivity verified (3 nodes online)
✓ Maritime synthesizer ready

Tables configured:
  - vessel_positions (target: VesselPositions)
  - port_events (target: PortEvents)
  - vessel_metadata (target: VesselMetadata)

Estimated costs (24 hour retention):
  BigQuery storage: ~$0.02/day
  BigQuery queries: Covered by free tier
  Streaming API: $0.00 (using Load Jobs API)

Ready to benchmark. Run: bq-benchmark run
```

#### 3.2 `bq-benchmark run`

Executes the benchmark.

```bash
bq-benchmark run [options]

Timing:
  --warmup <seconds>      Warmup phase duration (default: 120)
  --measure <seconds>     Measurement phase duration (default: 300)
  --cooldown <seconds>    Cooldown phase duration (default: 60)
  --sample-interval <s>   Checkpoint sampling interval (default: 5)

Output:
  --output <format>       Display format: live|logs (default: live)
  --report-file <path>    Report filename (default: ./benchmark-report-{timestamp}.md)
  --json                  Also generate JSON report
  --csv                   Also generate CSV files
  --no-graphs             Disable ASCII graphs in markdown (tables only)

Tables:
  --tables <ids>          Comma-separated table IDs to benchmark (default: all configured)

Advanced:
  --skip-warmup           Skip warmup phase (use for debugging only)
  --profile               Enable resource profiling (CPU, memory, network)
  --verbose               Enable detailed logging
```

**Actions:**
- Starts maritime synthesizer in background
- Starts/resumes Harper sync engine(s)
- Executes three-phase benchmark with configured timing
- Collects metrics during measurement phase
- Displays live dashboard (default) or streams logs
- Generates final report in requested format(s)

**Example usage:**

```bash
# Quick benchmark with defaults
bq-benchmark run

# Custom timing for longer test
bq-benchmark run --warmup 300 --measure 900 --cooldown 120

# Generate all report formats
bq-benchmark run --json --csv

# Benchmark specific table only
bq-benchmark run --tables vessel_positions

# Silent run with logs
bq-benchmark run --output logs > benchmark.log
```

#### 3.3 `bq-benchmark analyze`

Analyzes a previous benchmark run.

```bash
bq-benchmark analyze <report-file> [options]

Options:
  --compare <file2>       Compare two benchmark runs
  --format <type>         Output format: json|csv|markdown (default: markdown)
  --percentiles <list>    Latency percentiles to calculate (default: 50,95,99)
```

**Actions:**
- Loads benchmark report JSON
- Recalculates statistics with different parameters
- Generates visualizations or comparison tables
- Useful for post-run analysis without re-running benchmark

**Example:**

```bash
# Analyze previous run
bq-benchmark analyze benchmark-report-20260109-102315.json

# Compare two runs
bq-benchmark analyze run1.json --compare run2.json
```

#### 3.4 `bq-benchmark cleanup`

Removes benchmark data.

```bash
bq-benchmark cleanup [options]

Options:
  --bigquery              Delete BigQuery test data
  --harper                Delete Harper test data
  --all                   Delete both BigQuery and Harper data (default)
  --keep-reports          Don't delete benchmark report files
```

**Actions:**
- Stops any running benchmark processes
- Removes test data from BigQuery tables
- Removes test data from Harper tables
- Optionally removes benchmark report files

**Example:**

```bash
# Clean everything
bq-benchmark cleanup

# Clean only Harper data, keep BigQuery for re-testing
bq-benchmark cleanup --harper
```

---

## 4. Metrics Collection and Calculation

### Data Sources

#### 4.1 SyncCheckpoint Table (Primary Source)

**Query:** `SELECT * FROM SyncCheckpoint WHERE tableId = ?`

**Fields:**
- `checkpointId` - Composite key: `{tableId}_{nodeId}`
- `tableId` - BigQuery table identifier
- `nodeId` - Harper worker identifier
- `targetTable` - Harper table name
- `lastTimestamp` - Most recent BigQuery record timestamp ingested
- `recordsIngested` - Cumulative count of records ingested by this worker
- `phase` - Current sync phase (initial, catchup, steady)
- `updatedAt` - When checkpoint was last updated

**Polling interval:** Every 5 seconds during measurement phase

**Why SyncCheckpoint?**
- Strongly consistent (updated synchronously by sync engine)
- Authoritative source of ingestion progress
- Available immediately (no replication delay)
- Tracks exact record counts and timestamps

#### 4.2 Data Tables (Secondary Source - Query Availability)

**Query:** `SELECT COUNT(*) FROM {targetTable} WHERE _syncedAt >= ? AND _syncedAt <= ?`

**Purpose:** Measure when records become queryable across the cluster

**Why Data Tables?**
- Reflects real user experience (eventual consistency included)
- Validates checkpoint accuracy
- Identifies replication bottlenecks
- Shows complete pipeline performance

**Difference from Checkpoints:**
The gap between checkpoint-based and table-based metrics reveals Harper's replication performance:
- **Small gap (< 2%):** Replication is fast, cluster is healthy
- **Large gap (> 10%):** Replication is slow, potential bottleneck
- **Growing gap:** Replication falling behind, investigate cluster

#### 4.3 System Resources (Optional - `--profile` flag)

**Collected via Node.js APIs:**
- `process.memoryUsage()` - Heap, RSS, external memory
- `process.cpuUsage()` - User and system CPU time
- Network I/O via `/proc/net/dev` (Linux) or OS-specific APIs

**Collected per-node if cluster deployed**

#### 4.4 Data Size Estimation

**Method:**
- Sample 100 records from each target Harper table
- Calculate average record size: `JSON.stringify(record).length`
- Multiply by record counts for total MB throughput

**Cached:** Record size sampled once at benchmark start, cached for duration

### Metric Calculations

#### 4.1 Records/Minute

```javascript
// During measurement phase, collect samples
samples = [
  { time: t0, totalRecords: 125000 },
  { time: t1, totalRecords: 127500 },
  { time: t2, totalRecords: 130000 },
  ...
]

// Calculate instantaneous throughput between each sample pair
throughputs = []
for (i = 1; i < samples.length; i++) {
  deltaRecords = samples[i].totalRecords - samples[i-1].totalRecords
  deltaTimeMin = (samples[i].time - samples[i-1].time) / 60000
  throughputs.push(deltaRecords / deltaTimeMin)
}

// Final metrics
avgRecordsPerMin = mean(throughputs)
medianRecordsPerMin = median(throughputs)
minRecordsPerMin = min(throughputs)
maxRecordsPerMin = max(throughputs)
stdDev = standardDeviation(throughputs)
```

**Interpretation:**
- **Mean:** Average sustained throughput
- **Median:** Typical throughput (less affected by outliers)
- **Min/Max:** Range of observed throughput
- **Std Dev:** Throughput stability (lower = more stable)

#### 4.2 MB/Minute

```javascript
// Sample record size estimation (done once at start)
sampleSize = 100
records = await tables[targetTable].get({ limit: sampleSize })
avgRecordSizeBytes = sum(records.map(r => JSON.stringify(r).length)) / sampleSize

// Convert records/min to MB/min
avgMBPerMin = avgRecordsPerMin * avgRecordSizeBytes / (1024 * 1024)
```

**Note:** Uses JSON serialization size as proxy for actual data transfer size. This slightly overestimates due to JSON overhead, but provides consistent measurement.

#### 4.3 Latency Percentiles (P50, P95, P99)

```javascript
// For each checkpoint sample during measurement
latencies = []
for (sample of samples) {
  for (checkpoint of sample.checkpoints) {
    // lastTimestamp = most recent BigQuery record ingested
    // sample.time = when we observed this checkpoint
    syncLatencyMs = sample.time - new Date(checkpoint.lastTimestamp).getTime()
    latencies.push(syncLatencyMs)
  }
}

// Calculate percentiles
p50 = percentile(latencies, 50)  // Median
p95 = percentile(latencies, 95)  // 95% of records faster than this
p99 = percentile(latencies, 99)  // 99% of records faster than this
```

**Important:** This measures **sync latency** (time from BigQuery record timestamp to checkpoint update), not end-to-end latency. It represents how far behind the sync is from BigQuery's data.

**Interpretation:**
- **P50 (median):** Typical sync lag - target < 5 seconds for near-real-time
- **P95:** Most records synced within this time - target < 10 seconds
- **P99:** Tail latency - watch for outliers indicating issues

#### 4.4 Resource Utilization

```javascript
// Sampled at same interval as checkpoints
resourceSamples = [
  {
    time: t0,
    cpuPercent: 45.2,
    memoryMB: 512,
    networkInMBps: 8.3,
    networkOutMBps: 2.1
  },
  ...
]

// Aggregate statistics
avgCPU = mean(resourceSamples.map(s => s.cpuPercent))
peakCPU = max(resourceSamples.map(s => s.cpuPercent))
avgMemoryMB = mean(resourceSamples.map(s => s.memoryMB))
peakMemoryMB = max(resourceSamples.map(s => s.memoryMB))
avgNetworkInMBps = mean(resourceSamples.map(s => s.networkInMBps))
avgNetworkOutMBps = mean(resourceSamples.map(s => s.networkOutMBps))
```

#### 4.5 Replication Lag (Checkpoint vs Table-Based)

Measure the difference between ingestion speed (checkpoints) and query availability (tables):

```javascript
// For each sample during measurement
for (sample of samples) {
  // Checkpoint-based: records ingested by sync engine
  const checkpointRecords = sample.checkpoints.reduce(
    (sum, cp) => sum + cp.recordsIngested,
    0
  );

  // Table-based: records queryable in data tables
  const tableRecords = await queryTableCounts(sample.timestamp);

  // Calculate replication lag
  const replicationLag = {
    recordDelta: checkpointRecords - tableRecords,
    percentLag: ((checkpointRecords - tableRecords) / checkpointRecords) * 100,
    timestamp: sample.timestamp
  };

  replicationLags.push(replicationLag);
}

// Aggregate replication lag statistics
avgReplicationLagPercent = mean(replicationLags.map(r => r.percentLag))
maxReplicationLagPercent = max(replicationLags.map(r => r.percentLag))
```

**Query table counts:**

```javascript
async function queryTableCounts(timestamp) {
  let totalRecords = 0;

  for (const tableConfig of config.tables) {
    const sql = `
      SELECT COUNT(*) as count
      FROM ${tableConfig.targetTable}
      WHERE _syncedAt <= ?
    `;

    const result = await executeSql(sql, [timestamp]);
    totalRecords += result[0].count;
  }

  return totalRecords;
}
```

**Interpretation:**
- **< 1% lag:** Excellent replication performance
- **1-5% lag:** Good, typical for distributed systems
- **5-10% lag:** Acceptable under load
- **> 10% lag:** Investigate replication bottleneck

### Per-Table Metrics

When multiple tables are configured, calculate all metrics separately for each table and also provide cluster-wide aggregates:

```javascript
metrics = {
  clusterWide: {
    checkpoint: {
      // Ingestion throughput (from SyncCheckpoint table)
      throughput: {
        recordsPerMinute: { mean: 50000, median: 50200, min: 48000, max: 52000, stdDev: 850 },
        mbPerMinute: { mean: 125.0, median: 125.5, min: 120.0, max: 130.0, stdDev: 2.1 }
      },
      latency: {
        p50: 2340,
        p95: 4150,
        p99: 6820,
        unit: 'milliseconds'
      }
    },
    table: {
      // Query availability (from data tables)
      throughput: {
        recordsPerMinute: { mean: 49100, median: 49250, min: 47200, max: 51000, stdDev: 900 },
        mbPerMinute: { mean: 122.8, median: 123.1, min: 118.0, max: 127.5, stdDev: 2.3 }
      },
      latency: {
        p50: 3120,
        p95: 5200,
        p99: 7900,
        unit: 'milliseconds'
      }
    },
    replicationLag: {
      // Difference between checkpoint and table metrics
      percentLag: { mean: 1.8, median: 1.6, max: 3.2, unit: 'percent' },
      latencyDelta: { mean: 780, median: 750, max: 1200, unit: 'milliseconds' }
    },
    resources: { ... }
  },
  byTable: {
    vessel_positions: {
      checkpoint: {
        throughput: {
          recordsPerMinute: { mean: 40000, ... },
          mbPerMinute: { mean: 100.0, ... }
        },
        latency: { p50: 2100, p95: 3800, p99: 6200 }
      },
      table: {
        throughput: {
          recordsPerMinute: { mean: 39300, ... },
          mbPerMinute: { mean: 98.3, ... }
        },
        latency: { p50: 2850, p95: 4600, p99: 7100 }
      },
      replicationLag: { percentLag: { mean: 1.75, ... } }
    },
    port_events: { ... },
    vessel_metadata: { ... }
  }
}
```

---

## 5. Output Formats and Reporting

### Default Behavior

**During benchmark:** Live terminal dashboard
**After benchmark:** Markdown report with ASCII graphs saved to `benchmark-report-{timestamp}.md`

### Format 1: Live Dashboard (Default - Terminal UI)

Real-time terminal UI during benchmark execution:

```
╔════════════════════════════════════════════════════════════════╗
║              BigQuery → Harper Benchmark                       ║
╚════════════════════════════════════════════════════════════════╝

Phase: MEASUREMENT (3:45 / 5:00 remaining)
Progress: ████████████████████░░░░░░░░ 63%

─────────────────────────────────────────────────────────────────
Cluster Overview
─────────────────────────────────────────────────────────────────
Nodes:          3 active (node1-0, node2-0, node3-0)
Tables:         3 (vessel_positions, port_events, vessel_metadata)

─────────────────────────────────────────────────────────────────
Real-Time Throughput (last 30s average)
─────────────────────────────────────────────────────────────────
Records/min:    48,523  ████████████████████░░░ (target: 50k)
MB/min:         121.3   ████████████████████░░░
Sync Latency:   2.3s (P50)  4.1s (P95)  6.8s (P99)

─────────────────────────────────────────────────────────────────
Per-Table Breakdown
─────────────────────────────────────────────────────────────────
vessel_positions    39,200 rec/min    98.0 MB/min    steady
port_events          7,840 rec/min    19.6 MB/min    steady
vessel_metadata      1,483 rec/min     3.7 MB/min    steady

─────────────────────────────────────────────────────────────────
Resource Utilization (--profile enabled)
─────────────────────────────────────────────────────────────────
CPU:            45.2%   ██████████░░░░░░░░░░
Memory:         512 MB
Network In:     8.3 MB/s
Network Out:    2.1 MB/s

[Press Ctrl+C to stop benchmark]
```

**Implementation:**
- Uses `blessed` or `cli-progress` for terminal UI
- Updates every 2-3 seconds
- Shows phase progress bar
- Real-time throughput calculations
- Per-table breakdown
- Resource utilization (when `--profile` enabled)
- Uses ANSI escape codes for dynamic updates

### Format 2: Markdown Report with Graphs (Default)

Human-readable report with embedded ASCII/Unicode visualizations. See full example in Appendix A.

**Key sections:**
1. **Executive Summary** - One-paragraph overview of results
2. **Configuration** - Benchmark parameters and cluster topology
3. **Ingestion vs Query Availability** - Comparison of checkpoint-based and table-based metrics with replication lag analysis
4. **Throughput Over Time** - ASCII line graphs showing records/min and MB/min for both metrics
5. **Cluster-Wide Performance** - Summary tables with statistics for both ingestion and query availability
6. **Latency Distribution** - Percentile tables and graphs for both metrics
7. **Per-Table Breakdown** - Detailed metrics for each table
8. **Resource Utilization** - CPU, memory, network graphs
9. **Phase Breakdown** - Timeline and per-phase statistics
10. **Conclusion** - Key findings and recommendations

**Filename:** `benchmark-report-{timestamp}.md` (e.g., `benchmark-report-20260109-102315.md`)

**Graph implementation:** Uses `asciichart` npm package for generating ASCII/Unicode charts.

### Format 3: JSON Report (Optional - `--json` flag)

Comprehensive machine-readable output saved to `benchmark-report-{timestamp}.json`.

**Structure:**

```json
{
  "benchmark": {
    "id": "bench_20260109_102315_a3f7",
    "startTime": "2026-01-09T10:23:15.000Z",
    "endTime": "2026-01-09T10:31:15.000Z",
    "totalDuration": 480,
    "version": "1.0.0"
  },
  "configuration": {
    "warmupSeconds": 120,
    "measureSeconds": 300,
    "cooldownSeconds": 60,
    "sampleInterval": 5,
    "tables": ["vessel_positions", "port_events", "vessel_metadata"],
    "cluster": {
      "nodes": ["node1-0", "node2-0", "node3-0"],
      "size": 3
    }
  },
  "phases": {
    "warmup": { "duration": 120, "startRecords": 0, "endRecords": 96500, "status": "completed" },
    "measurement": { "duration": 300, "startRecords": 96500, "endRecords": 338750, "samplesCollected": 60, "status": "completed" },
    "cooldown": { "duration": 60, "startRecords": 338750, "endRecords": 387250, "status": "completed" }
  },
  "metrics": {
    "clusterWide": { ... },
    "byTable": { ... },
    "resources": { ... }
  },
  "samples": [
    {
      "timestamp": "2026-01-09T10:25:15.000Z",
      "phaseElapsed": 0,
      "checkpoints": [ ... ],
      "resources": { ... }
    },
    ...
  ]
}
```

**Use cases:**
- Programmatic analysis of benchmark results
- Integration with monitoring/alerting systems
- Long-term trend analysis
- Automated performance regression testing

### Format 4: CSV Format (Optional - `--csv` flag)

Simplified tabular format for spreadsheet analysis. Generates three files:

**benchmark-summary.csv:**
```csv
Metric,Value,Unit
Total Duration,480,seconds
Warmup Duration,120,seconds
Measurement Duration,300,seconds
Avg Records/Min,48450,records
Avg MB/Min,121.1,MB
Median Latency,2340,ms
P95 Latency,4150,ms
...
```

**benchmark-samples.csv:**
```csv
Timestamp,Phase,ElapsedSeconds,TotalRecords,RecordsPerMin,MBPerMin,LatencyP50,CPU,Memory
2026-01-09T10:25:15Z,measurement,0,96500,,,,,
2026-01-09T10:25:20Z,measurement,5,100542,48504,121.3,2340,44.2,498
...
```

**benchmark-by-table.csv:**
```csv
Table,RecordsPerMin,MBPerMin,LatencyP50,LatencyP95,LatencyP99
vessel_positions,39180,97.9,2100,3800,6200
port_events,7835,19.6,2400,4200,7100
vessel_metadata,1435,3.6,3100,5200,8500
```

### Format 5: Logs Format (Optional - `--output logs`)

Structured log output for piping to monitoring systems:

```
[2026-01-09T10:23:15.000Z] INFO benchmark.start id=bench_20260109_102315_a3f7
[2026-01-09T10:23:15.001Z] INFO phase.warmup duration=120
[2026-01-09T10:25:15.000Z] INFO phase.measurement duration=300
[2026-01-09T10:25:20.000Z] METRIC cluster.throughput records_per_min=48504 mb_per_min=121.3
[2026-01-09T10:25:20.001Z] METRIC cluster.latency p50=2340 p95=4150 p99=6820
[2026-01-09T10:25:20.002Z] METRIC table.vessel_positions records_per_min=39200 mb_per_min=98.0
[2026-01-09T10:25:20.003Z] METRIC resources cpu_percent=44.2 memory_mb=498
...
```

**Format:** `[ISO_TIMESTAMP] LEVEL category.event key=value ...`

**Use cases:**
- Integration with log aggregation systems (Splunk, ELK, etc.)
- Real-time monitoring dashboards
- Alerting on performance degradation
- Continuous integration pipelines

### File Output Summary

| Format | Default? | Flag | Filename Pattern |
|--------|----------|------|------------------|
| Markdown | ✓ | (default) | `benchmark-report-{timestamp}.md` |
| JSON | ✗ | `--json` | `benchmark-report-{timestamp}.json` |
| CSV | ✗ | `--csv` | `benchmark-summary.csv`, `benchmark-samples.csv`, `benchmark-by-table.csv` |
| Logs | ✗ | `--output logs` | Streams to stdout |

**Examples:**

```bash
# Default: Live dashboard + Markdown with graphs
bq-benchmark run
# Creates: benchmark-report-20260109-102315.md

# Add JSON for programmatic access
bq-benchmark run --json
# Creates: benchmark-report-20260109-102315.md + .json

# All formats
bq-benchmark run --json --csv
# Creates: .md + .json + 3 CSV files

# Silent run with logs only
bq-benchmark run --output logs > benchmark.log
# Streams logs, creates: benchmark-report-20260109-102315.md

# Custom report filename
bq-benchmark run --report-file ./results/my-benchmark.md
```

### Markdown Report Example Snippet

Here's what the "Ingestion vs Query Availability" section looks like in the Markdown report:

````markdown
## Ingestion vs Query Availability

This section compares two measurements of system throughput:
- **Checkpoint-based (Ingestion):** How fast data enters Harper (measured via SyncCheckpoint table)
- **Table-based (Query Availability):** How fast data becomes queryable (measured via actual data tables)

The difference between these metrics reveals Harper's replication performance.

### Throughput Comparison

| Metric | Checkpoint (Ingestion) | Table (Query Available) | Delta | Replication Lag |
|--------|------------------------|-------------------------|-------|-----------------|
| **Records/min** | 50,000 | 49,100 | -900 | 1.8% |
| **MB/min** | 125.0 | 122.8 | -2.2 MB | 1.8% |
| **P50 Latency** | 2.34s | 3.12s | +780ms | - |
| **P95 Latency** | 4.15s | 5.20s | +1.05s | - |

### Throughput Over Time (Both Metrics)

Records per minute - Checkpoint vs Table:

```
52k ┤     ╭─────────────────╮
50k ┤  ╭──╯                 ╰──╮
48k ┤╭─╯                       ╰─╮
46k ┼╯          Checkpoint       ╰─╮
44k ┤                              ╰──
    └────┬────┬────┬────┬────┬────┬────┬────
        0m   1m   2m   3m   4m   5m

52k ┤     ╭────────────────╮
50k ┤  ╭──╯                ╰──╮
48k ┼─╯                       ╰─╮
46k ┤         Table-based       ╰─╮
44k ┤                              ╰──
    └────┬────┬────┬────┬────┬────┬────┬────
        0m   1m   2m   3m   4m   5m

        ─── Ingestion (checkpoints)  [Avg: 50.0k]
        ─ ─ Query Availability (tables)  [Avg: 49.1k]
```

### Replication Lag Over Time

Percentage lag between ingestion and query availability:

```
3% ┤           ╭╮
2% ┤      ╭────╯╰───╮
1% ┼──────╯         ╰────────
0% ┤
   └────┬────┬────┬────┬────┬────┬────┬────
       0m   1m   2m   3m   4m   5m

       Mean: 1.8%  Max: 3.2%  Target: < 5%
```

### Analysis

✓ **Excellent replication performance:** Average lag of 1.8% indicates Harper is replicating data quickly
✓ **Stable replication:** Max lag of 3.2% shows consistent performance under load
✓ **Query availability latency:** Additional 780ms (P50) for data to become queryable is acceptable
✓ **Production-ready:** Replication performance meets typical distributed system standards

The small gap between ingestion and query availability confirms that Harper's eventual consistency delay is minimal for this workload.
````

---

## 6. Implementation Details

### 6.1 Project Structure

```
tools/
└── bq-benchmark/
    ├── cli.js                          # Main CLI entry point
    ├── package.json                    # Dependencies and bin configuration
    ├── README.md                       # Tool-specific documentation
    │
    ├── lib/
    │   ├── benchmark-runner.js         # Core benchmark orchestration
    │   ├── metrics-collector.js        # Checkpoint sampling & metric calculation
    │   ├── phase-manager.js            # Warmup/Measure/Cooldown phase control
    │   ├── data-synthesizer.js         # Wrapper for maritime synthesizer
    │   ├── checkpoint-client.js        # Query SyncCheckpoint table via REST API
    │   ├── resource-monitor.js         # CPU/memory/network profiling
    │   └── sliding-window.js           # Throughput calculation algorithms
    │
    ├── reporters/
    │   ├── live-dashboard.js           # Terminal UI renderer
    │   ├── markdown-reporter.js        # Markdown with graphs generator
    │   ├── json-reporter.js            # JSON report generator
    │   ├── csv-reporter.js             # CSV export generator
    │   ├── logs-reporter.js            # Structured log output
    │   └── chart-renderer.js           # ASCII chart generation
    │
    ├── commands/
    │   ├── setup.js                    # Setup command implementation
    │   ├── run.js                      # Run command implementation
    │   ├── analyze.js                  # Analyze command implementation
    │   └── cleanup.js                  # Cleanup command implementation
    │
    └── utils/
        ├── config-loader.js            # Load Harper/BigQuery config
        ├── validation.js               # Pre-flight checks
        └── format-helpers.js           # Number formatting, time formatting
```

### 6.2 Core Modules

#### benchmark-runner.js

Main orchestrator that coordinates the entire benchmark.

**Key responsibilities:**
- Pre-flight validation (BigQuery auth, Harper connectivity)
- Start/stop data synthesizer
- Coordinate three-phase execution
- Collect samples via MetricsCollector
- Calculate final metrics via SlidingWindow
- Generate reports in all requested formats

**Pseudocode:**

```javascript
export class BenchmarkRunner {
  constructor(config) {
    this.config = config;
    this.phaseManager = new PhaseManager(config);
    this.metricsCollector = new MetricsCollector(config);
    this.dataSynthesizer = new DataSynthesizer(config);
    this.checkpointClient = new CheckpointClient(config);
    this.resourceMonitor = config.profile ? new ResourceMonitor() : null;
  }

  async run() {
    // Pre-flight validation
    await this.validate();

    // Start data generation in background
    await this.dataSynthesizer.start();

    // Phase 1: Warmup
    const warmupResults = await this.phaseManager.runWarmup(
      async () => await this.metricsCollector.sample()
    );

    // Phase 2: Measurement (collect samples)
    const measurementResults = await this.phaseManager.runMeasurement(
      async () => await this.metricsCollector.sample()
    );

    // Phase 3: Cooldown
    const cooldownResults = await this.phaseManager.runCooldown(
      async () => await this.metricsCollector.sample()
    );

    // Stop data generation
    await this.dataSynthesizer.stop();

    // Calculate final metrics
    const metrics = this.calculateMetrics(measurementResults);

    // Generate reports
    await this.generateReports(metrics, measurementResults);

    return metrics;
  }

  calculateMetrics(samples) {
    const window = new SlidingWindow(samples);
    return {
      throughput: window.calculateThroughput(),
      latency: window.calculateLatency(),
      resources: this.resourceMonitor?.getStatistics()
    };
  }
}
```

#### metrics-collector.js

Samples checkpoints and calculates instantaneous metrics.

**Key responsibilities:**
- Query SyncCheckpoint table via REST API (checkpoint-based metrics)
- Query data tables via REST API (table-based metrics)
- Aggregate checkpoint data across nodes and tables
- Estimate data size by sampling target tables
- Calculate replication lag between checkpoint and table metrics
- Collect resource utilization (when profiling enabled)
- Return structured sample object

**Key methods:**
- `sample()` - Collect one sample (checkpoints + table counts + resources)
- `estimateBytes(checkpoints)` - Calculate total data size
- `sampleRecordSize(tableName)` - Estimate average record size
- `aggregateByTable(checkpoints)` - Group by table ID
- `queryTableCounts(timestamp)` - Query actual data table counts for validation
- `calculateReplicationLag(checkpointRecords, tableRecords)` - Calculate lag

**Sample caching:**
Record sizes are sampled once at benchmark start and cached for the duration. This avoids repeated sampling overhead.

#### phase-manager.js

Controls phase timing and sample collection.

**Key responsibilities:**
- Execute warmup/measurement/cooldown phases
- Call sample function at regular intervals
- Update live reporter with current phase progress
- Calculate instantaneous throughput for live display
- Handle interruption (Ctrl+C) gracefully

**Key methods:**
- `runWarmup(sampleFn)` - Execute warmup phase, discard samples
- `runMeasurement(sampleFn)` - Execute measurement phase, keep samples
- `runCooldown(sampleFn)` - Execute cooldown phase, keep samples
- `calculateInstantThroughput(prev, curr)` - For live display

#### sliding-window.js

Calculates throughput and latency statistics from samples.

**Key responsibilities:**
- Calculate instantaneous throughput between consecutive samples
- Compute statistical aggregates (mean, median, min, max, stdDev)
- Calculate latency percentiles (P50, P95, P99)
- Per-table breakdowns

**Key methods:**
- `calculateThroughput()` - Records/min and MB/min statistics
- `calculateLatency()` - Percentile calculations
- `calculateStats(values)` - Mean, median, min, max, stdDev
- `percentile(sortedValues, p)` - Percentile calculation

**Algorithm for throughput:**

```javascript
throughputs = []
for (i = 1; i < samples.length; i++) {
  deltaRecords = samples[i].totalRecords - samples[i-1].totalRecords
  deltaTimeMin = (samples[i].time - samples[i-1].time) / 60000
  throughputs.push(deltaRecords / deltaTimeMin)
}

return {
  mean: average(throughputs),
  median: median(throughputs),
  min: min(throughputs),
  max: max(throughputs),
  stdDev: standardDeviation(throughputs)
}
```

#### checkpoint-client.js

Interface to Harper SyncCheckpoint table.

**Key responsibilities:**
- Query SyncCheckpoint table via REST API
- Handle authentication
- Parse and validate checkpoint data
- Support filtering by table ID

**Key methods:**
- `getAll()` - Query all checkpoints
- `getByTable(tableId)` - Query checkpoints for specific table

**REST API usage:**

```javascript
// Query all checkpoints
GET http://localhost:9926/SyncCheckpoint/
Authorization: Basic {base64(username:password)}

// Query specific table via SQL
POST http://localhost:9926/
Content-Type: application/json
Authorization: Basic {base64(username:password)}
Body: { "sql": "SELECT * FROM SyncCheckpoint WHERE tableId = 'vessel_positions'" }
```

### 6.3 Reporter Modules

#### live-dashboard.js

Real-time terminal UI using `blessed` or `cli-progress`.

**Key features:**
- Progress bar showing phase completion
- Real-time throughput display (last 30s rolling average)
- Per-table breakdown
- Resource utilization graphs
- Updates every 2-3 seconds

**Implementation note:** Use `blessed` for rich terminal UI with multiple panes, or `cli-progress` for simpler progress bars.

#### markdown-reporter.js

Generates comprehensive Markdown report with ASCII graphs.

**Key features:**
- Executive summary with key findings
- ASCII line charts showing throughput over time
- Statistical tables with all metrics
- Per-table breakdown with individual charts
- Resource utilization graphs
- Conclusion with recommendations

**Uses `asciichart` package for graph generation.**

#### json-reporter.js

Generates machine-readable JSON report.

**Structure includes:**
- Benchmark metadata (ID, timestamps, duration)
- Configuration (timing, cluster, tables)
- Phase results (duration, records processed)
- Metrics (cluster-wide and per-table)
- Raw samples (all checkpoint snapshots)
- Resource utilization

#### csv-reporter.js

Generates CSV files for spreadsheet analysis.

**Generates three files:**
1. `benchmark-summary.csv` - Key metrics summary
2. `benchmark-samples.csv` - Time-series data
3. `benchmark-by-table.csv` - Per-table metrics

#### chart-renderer.js

Utility for rendering ASCII charts used by markdown-reporter.

**Key methods:**
- `renderLineChart(data, options)` - Line chart for throughput over time
- `renderBarChart(data, options)` - Bar chart for per-table comparison
- `renderProgressBar(current, total, width)` - Progress bar

**Uses `asciichart` package.**

### 6.4 Dependencies

Add to `tools/bq-benchmark/package.json`:

```json
{
  "name": "bq-benchmark",
  "version": "1.0.0",
  "description": "BigQuery to Harper throughput benchmarking tool",
  "type": "module",
  "bin": {
    "bq-benchmark": "./cli.js"
  },
  "dependencies": {
    "commander": "^12.0.0",        // CLI framework
    "asciichart": "^1.5.25",       // ASCII charts for markdown
    "chalk": "^5.3.0",             // Terminal colors
    "ora": "^8.0.1",               // Spinner for progress
    "node-fetch": "^3.3.2",        // HTTP client for REST API
    "cli-progress": "^3.12.0",     // Progress bars
    "blessed": "^0.1.81",          // Terminal UI (optional, for rich dashboard)
    "blessed-contrib": "^4.11.0"   // Charts for terminal UI (optional)
  },
  "devDependencies": {
    "eslint": "^9.35.0",
    "prettier": "^3.6.2"
  },
  "scripts": {
    "test": "node --test test/**/*.test.js",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```

### 6.5 Integration with Existing Code

#### Reuse Maritime Synthesizer

```javascript
// lib/data-synthesizer.js
import { spawn } from 'child_process';

export class DataSynthesizer {
  async start() {
    // Spawn maritime-data-synthesizer as subprocess
    this.process = spawn('maritime-data-synthesizer', ['start', '--continuous']);

    // Wait for initial data generation
    await this.waitForData();
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      await this.waitForExit();
    }
  }

  async waitForData() {
    // Poll BigQuery until data exists
    // Or wait for synthesizer to signal readiness
  }
}
```

#### Load Existing Config

```javascript
// utils/config-loader.js
import { loadConfig } from '../../src/config-loader.js';

export async function loadBenchmarkConfig(configPath) {
  // Reuse existing config loader
  const config = await loadConfig(configPath || './config.yaml');

  // Add benchmark-specific settings
  return {
    ...config,
    harperUrl: `http://${config.operations.host}:${config.operations.port}`,
    harperAuth: `Basic ${Buffer.from(
      `${config.operations.username}:${config.operations.password}`
    ).toString('base64')}`,
    bigqueryProject: config.bigquery.projectId,
    bigqueryDataset: config.bigquery.tables[0]?.dataset || config.bigquery.dataset
  };
}
```

### 6.6 Error Handling

Comprehensive error handling for common failure scenarios:

```javascript
// Each command wraps execution with try/catch
export async function runCommand(options) {
  try {
    const runner = new BenchmarkRunner(options);
    const results = await runner.run();

    console.log('✓ Benchmark completed successfully');
    return results;

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('✗ Cannot connect to Harper. Is it running?');
      console.error(`  Expected: ${options.harperUrl}`);
    } else if (error.code === 'BIGQUERY_AUTH_FAILED') {
      console.error('✗ BigQuery authentication failed. Check credentials.');
      console.error('  Verify service-account-key.json is valid');
    } else if (error.code === 'NO_CHECKPOINTS') {
      console.error('✗ No checkpoint data found. Is sync running?');
      console.error('  Run: harper dev . (in project directory)');
    } else if (error.code === 'SYNTHESIZER_FAILED') {
      console.error('✗ Maritime synthesizer failed to start.');
      console.error('  Check BigQuery permissions and quotas');
    } else {
      console.error('✗ Benchmark failed:', error.message);
      if (options.verbose) {
        console.error(error.stack);
      }
    }

    process.exit(1);
  }
}
```

**Error codes:**
- `ECONNREFUSED` - Cannot connect to Harper
- `BIGQUERY_AUTH_FAILED` - BigQuery authentication failed
- `NO_CHECKPOINTS` - No checkpoint data (sync not running)
- `SYNTHESIZER_FAILED` - Maritime synthesizer failed
- `INVALID_CONFIG` - Configuration validation failed
- `INSUFFICIENT_DATA` - Not enough data for meaningful benchmark

### 6.7 Testing Strategy

#### Unit Tests

Test individual components in isolation:

**sliding-window.test.js:**
```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SlidingWindow } from '../lib/sliding-window.js';

describe('SlidingWindow', () => {
  it('calculates throughput correctly', () => {
    const samples = [
      { timestamp: new Date('2026-01-09T10:00:00Z'), totalRecords: 1000, totalBytes: 100000 },
      { timestamp: new Date('2026-01-09T10:00:05Z'), totalRecords: 1500, totalBytes: 150000 }
    ];

    const window = new SlidingWindow(samples);
    const throughput = window.calculateThroughput();

    // 500 records in 5 seconds = 6000 records/min
    assert.strictEqual(Math.round(throughput.recordsPerMinute.mean), 6000);
  });

  it('calculates latency percentiles correctly', () => {
    const samples = [
      {
        timestamp: new Date('2026-01-09T10:00:05Z'),
        checkpoints: [
          { lastTimestamp: '2026-01-09T10:00:02Z' },
          { lastTimestamp: '2026-01-09T10:00:03Z' },
          { lastTimestamp: '2026-01-09T10:00:04Z' }
        ]
      }
    ];

    const window = new SlidingWindow(samples);
    const latency = window.calculateLatency();

    // Latencies: 3000ms, 2000ms, 1000ms
    assert.strictEqual(latency.p50, 2000);
  });
});
```

**metrics-collector.test.js:**
```javascript
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { MetricsCollector } from '../lib/metrics-collector.js';

describe('MetricsCollector', () => {
  it('aggregates checkpoints by table', async () => {
    const mockClient = {
      getAll: async () => [
        { tableId: 'table1', nodeId: 'node1', recordsIngested: 1000 },
        { tableId: 'table1', nodeId: 'node2', recordsIngested: 1500 },
        { tableId: 'table2', nodeId: 'node1', recordsIngested: 500 }
      ]
    };

    const collector = new MetricsCollector({ checkpointClient: mockClient });
    const sample = await collector.sample();

    assert.strictEqual(sample.byTable.length, 2);
    assert.strictEqual(sample.byTable[0].recordsIngested, 2500); // table1
    assert.strictEqual(sample.byTable[1].recordsIngested, 500);  // table2
  });
});
```

**chart-renderer.test.js:**
```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderLineChart } from '../reporters/chart-renderer.js';

describe('ChartRenderer', () => {
  it('renders ASCII line chart', () => {
    const data = [10, 20, 15, 25, 30];
    const chart = renderLineChart(data, { height: 5, width: 20 });

    assert.ok(chart.includes('┤'));
    assert.ok(chart.includes('└'));
    assert.strictEqual(chart.split('\n').length, 6); // 5 rows + axis
  });
});
```

#### Integration Tests

Test end-to-end with real Harper instance:

**integration.test.js:**
```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { BenchmarkRunner } from '../lib/benchmark-runner.js';
import { spawn } from 'child_process';

describe('BenchmarkRunner Integration', () => {
  let harperProcess;

  before(async () => {
    // Start Harper in test mode
    harperProcess = spawn('harper', ['dev', '.']);
    await waitForHarper();
  });

  after(() => {
    if (harperProcess) {
      harperProcess.kill();
    }
  });

  it('completes full benchmark run', async () => {
    const config = {
      warmupSeconds: 10,
      measureSeconds: 30,
      cooldownSeconds: 10,
      sampleInterval: 5,
      harperUrl: 'http://localhost:9926',
      harperAuth: 'Basic ...',
      profile: false
    };

    const runner = new BenchmarkRunner(config);
    const results = await runner.run();

    assert.ok(results.metrics.throughput.recordsPerMinute.mean > 0);
    assert.ok(results.metrics.latency.p50 > 0);
  });
});
```

#### Manual Testing

**Quick smoke test (1 minute):**
```bash
bq-benchmark run --warmup 10 --measure 30 --cooldown 10
```

**Full test (default timing):**
```bash
bq-benchmark setup --vessels 100000
bq-benchmark run
bq-benchmark cleanup
```

**Multi-format test:**
```bash
bq-benchmark run --json --csv --profile
# Verify all files created: .md, .json, 3x .csv
```

---

## 7. Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

**Tasks:**
1. Project structure setup (`tools/bq-benchmark/`)
2. CLI framework with `commander` (`cli.js`, `commands/`)
3. Config loader integration (`utils/config-loader.js`)
4. Checkpoint client implementation (`lib/checkpoint-client.js`)
5. Basic validation (`utils/validation.js`)

**Deliverable:** `bq-benchmark --help` works, `setup` command validates connectivity

### Phase 2: Metrics Collection (Week 1)

**Tasks:**
1. Metrics collector (`lib/metrics-collector.js`)
2. Sliding window calculations (`lib/sliding-window.js`)
3. Resource monitor (`lib/resource-monitor.js`)
4. Unit tests for calculations

**Deliverable:** Can collect and calculate metrics from running sync

### Phase 3: Phase Management (Week 2)

**Tasks:**
1. Phase manager (`lib/phase-manager.js`)
2. Benchmark runner orchestration (`lib/benchmark-runner.js`)
3. Data synthesizer wrapper (`lib/data-synthesizer.js`)
4. Integration tests

**Deliverable:** `bq-benchmark run` completes three-phase benchmark

### Phase 4: Reporting (Week 2)

**Tasks:**
1. Markdown reporter with graphs (`reporters/markdown-reporter.js`)
2. JSON reporter (`reporters/json-reporter.js`)
3. CSV reporter (`reporters/csv-reporter.js`)
4. Chart renderer (`reporters/chart-renderer.js`)

**Deliverable:** All report formats generated correctly

### Phase 5: Live Dashboard (Week 3)

**Tasks:**
1. Live dashboard UI (`reporters/live-dashboard.js`)
2. Logs reporter (`reporters/logs-reporter.js`)
3. Signal handling (Ctrl+C gracefully stops)
4. Polish and formatting

**Deliverable:** Beautiful live dashboard with real-time updates

### Phase 6: Additional Commands (Week 3)

**Tasks:**
1. `analyze` command implementation (`commands/analyze.js`)
2. `cleanup` command implementation (`commands/cleanup.js`)
3. Comparison mode for `analyze`
4. Documentation and examples

**Deliverable:** All commands functional, documentation complete

### Phase 7: Testing & Polish (Week 4)

**Tasks:**
1. Comprehensive unit tests
2. Integration tests with real Harper
3. Error handling improvements
4. Performance optimization
5. Documentation review
6. Example benchmark reports

**Deliverable:** Production-ready tool with full test coverage

---

## 8. Success Criteria

### Functional Requirements

✓ **Accurate throughput measurement**
- Records/min calculated correctly from checkpoint deltas
- MB/min accounts for actual data size
- Measurements exclude warmup/cooldown artifacts

✓ **Stable metrics**
- Standard deviation < 5% of mean for stable workloads
- Percentile calculations accurate
- Resource metrics match system monitoring tools

✓ **Comprehensive reporting**
- Markdown report with graphs (default)
- JSON/CSV optional formats
- Live dashboard updates in real-time

✓ **Reliable execution**
- Handles Harper connectivity issues gracefully
- Recovers from transient BigQuery errors
- Ctrl+C stops cleanly with partial results

✓ **Easy to use**
- `bq-benchmark setup && bq-benchmark run` works out of box
- Sensible defaults (2/5/1 min timing)
- Clear error messages

### Non-Functional Requirements

✓ **Performance**
- Minimal overhead on Harper cluster (< 1% CPU)
- Checkpoint queries < 100ms
- Report generation < 5 seconds

✓ **Maintainability**
- Modular architecture (separate concerns)
- Comprehensive unit tests (> 80% coverage)
- Clear documentation

✓ **Usability**
- Beautiful terminal UI
- Professional Markdown reports
- Machine-readable JSON for automation

---

## 9. Future Enhancements (Post v1.0)

### v1.1 Features

**Comparison mode:**
- `bq-benchmark compare run1.json run2.json`
- Side-by-side metric comparison
- Regression detection

**Cost estimation:**
- Calculate BigQuery query costs
- Estimate Harper storage costs
- ROI analysis for cluster sizing

### v1.2 Features

**Automated tuning:**
- Recommend optimal batch sizes
- Suggest cluster sizing based on target throughput
- Detect bottlenecks (BigQuery, network, Harper)

**Long-running benchmarks:**
- Support for multi-hour benchmarks
- Periodic report snapshots
- Trend analysis over time

### v2.0 Features

**Multi-cluster comparison:**
- Benchmark multiple cluster configurations
- A/B testing for optimization
- Automated recommendation engine

**Integration with CI/CD:**
- GitHub Actions workflow
- Performance regression detection
- Automated benchmarking on PRs

---

## Appendix A: Full Markdown Report Example

See separate file: `benchmark-report-example.md`

Key sections included:
- Executive Summary
- Configuration details
- **Ingestion vs Query Availability** - Dual metrics comparison showing:
  - Checkpoint-based throughput (ingestion speed)
  - Table-based throughput (query availability)
  - Replication lag analysis
  - Side-by-side graphs showing both metrics over time
- Throughput graphs (records/min, MB/min for both checkpoint and table-based)
- Cluster-wide performance tables (both metrics)
- Latency distribution graph and tables (both metrics)
- Per-table breakdown with individual metrics (checkpoint, table, and replication lag)
- Resource utilization graphs (CPU, memory, network)
- Phase breakdown timeline
- Conclusion with recommendations including replication performance analysis

---

## Appendix B: Configuration File Reference

The tool uses the existing `config.yaml` from the BigQuery Ingestor plugin:

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
      sync:
        initialBatchSize: 10000
        catchupBatchSize: 1000
        steadyBatchSize: 500

operations:
  host: localhost
  port: 9925
  username: admin
  password: your-password

synthesizer:
  dataset: maritime_tracking
  table: vessel_positions
  totalVessels: 100000
  batchSize: 100
  generationIntervalMs: 60000
```

**Benchmark-specific overrides:**

Via CLI flags:
- `--warmup <seconds>` - Override warmup duration
- `--measure <seconds>` - Override measurement duration
- `--cooldown <seconds>` - Override cooldown duration
- `--tables <ids>` - Override which tables to benchmark

---

## Appendix C: Dependencies and Installation

### Prerequisites

- Node.js >= 20
- Harper instance running
- BigQuery project with credentials
- Maritime data synthesizer configured

### Installation

```bash
# From project root
cd tools/bq-benchmark
npm install

# Add to PATH (or use via npx)
npm link

# Verify installation
bq-benchmark --version
bq-benchmark --help
```

### Dependencies

See section 6.4 for full dependency list.

**Key dependencies:**
- `commander` - CLI framework
- `asciichart` - ASCII charts
- `chalk` - Terminal colors
- `blessed` - Terminal UI (optional, for rich dashboard)

---

## Appendix D: Troubleshooting

### Common Issues

**Issue:** "Cannot connect to Harper"
```bash
✗ Cannot connect to Harper. Is it running?
  Expected: http://localhost:9926
```
**Solution:** Start Harper: `harper dev .`

---

**Issue:** "No checkpoint data found"
```bash
✗ No checkpoint data found. Is sync running?
```
**Solution:** Verify sync is running: `curl http://localhost:9926/SyncControl/`

---

**Issue:** "BigQuery authentication failed"
```bash
✗ BigQuery authentication failed. Check credentials.
```
**Solution:** Verify `service-account-key.json` exists and is valid

---

**Issue:** "Maritime synthesizer failed to start"
```bash
✗ Maritime synthesizer failed to start.
  Check BigQuery permissions and quotas
```
**Solution:** Verify BigQuery write permissions, check quotas

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-01-09 | 1.1 | Design Team | Added dual metrics (checkpoint + table-based) to measure both ingestion speed and query availability, including replication lag analysis |
| 2026-01-09 | 1.0 | Design Team | Initial design document |

---

**Status:** Ready for Implementation
**Next Steps:** Begin Phase 1 implementation (Core Infrastructure)
