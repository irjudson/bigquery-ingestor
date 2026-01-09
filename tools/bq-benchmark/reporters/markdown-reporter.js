/**
 * Markdown Reporter
 *
 * Generates comprehensive Markdown report with benchmark results.
 * MVP version: Basic tables and statistics (ASCII graphs to be added later).
 */

import { writeFileSync } from 'fs';

export class MarkdownReporter {
	/**
	 * Generate markdown report from benchmark results
	 *
	 * @param {Object} results - Benchmark results
	 * @param {string} [filename] - Output filename (optional)
	 * @returns {string} Generated markdown content
	 */
	static generate(results, filename = null) {
		const md = [];

		// Header
		md.push('# BigQuery → Harper Benchmark Report');
		md.push('');
		md.push(`**Benchmark ID:** ${results.benchmark.id}`);
		md.push(`**Date:** ${results.benchmark.startTime}`);
		md.push(
			`**Duration:** ${Math.floor(results.benchmark.totalDuration / 60)} minutes (${results.configuration.warmupSeconds / 60}min warmup, ${results.configuration.measureSeconds / 60}min measurement, ${results.configuration.cooldownSeconds / 60}min cooldown)`
		);
		md.push('');

		// Configuration
		md.push('## Configuration');
		md.push('');
		md.push(`- **Tables:** ${results.configuration.tables.join(', ')}`);
		md.push(`- **Harper:** ${results.configuration.cluster.harperUrl}`);
		md.push(`- **Sample Interval:** ${results.configuration.sampleInterval} seconds`);
		md.push(`- **Profiling:** ${results.configuration.profile ? 'Enabled' : 'Disabled'}`);
		md.push('');

		// Executive Summary
		md.push('## Executive Summary');
		md.push('');
		const checkpointRecords = results.metrics.clusterWide.checkpoint.throughput.recordsPerMinute.mean;
		const checkpointMB = results.metrics.clusterWide.checkpoint.throughput.mbPerMinute.mean;
		const tableRecords = results.metrics.clusterWide.table.throughput.recordsPerMinute.mean;
		const repLag = results.metrics.clusterWide.replicationLag.percentLag.mean;

		md.push(
			`The cluster sustained an average ingestion throughput of **${Math.round(checkpointRecords).toLocaleString()} records/min** (${checkpointMB.toFixed(1)} MB/min) during the ${results.configuration.measureSeconds / 60}-minute measurement window.`
		);
		md.push('');
		md.push(
			`Query availability throughput was **${Math.round(tableRecords).toLocaleString()} records/min**, with an average replication lag of ${repLag.toFixed(1)}% (${repLag < 2 ? 'excellent' : repLag < 5 ? 'good' : 'acceptable'}).`
		);
		md.push('');

		// Ingestion vs Query Availability
		md.push('---');
		md.push('');
		md.push('## Ingestion vs Query Availability');
		md.push('');
		md.push('This section compares two measurements of system throughput:');
		md.push('- **Checkpoint-based (Ingestion):** How fast data enters Harper (measured via SyncCheckpoint table)');
		md.push('- **Table-based (Query Availability):** How fast data becomes queryable (measured via actual data tables)');
		md.push('');
		md.push('The difference between these metrics reveals Harper\'s replication performance.');
		md.push('');

		// Throughput Comparison Table
		md.push('### Throughput Comparison');
		md.push('');
		md.push('| Metric | Checkpoint (Ingestion) | Table (Query Available) | Delta | Replication Lag |');
		md.push('|--------|------------------------|-------------------------|-------|-----------------|');

		const checkpointLatency = results.metrics.clusterWide.checkpoint.latency.p50;
		const tableLatency = results.metrics.clusterWide.table.latency.p50;
		const latencyDelta = tableLatency - checkpointLatency;

		md.push(
			`| **Records/min** | ${Math.round(checkpointRecords).toLocaleString()} | ${Math.round(tableRecords).toLocaleString()} | -${Math.round(checkpointRecords - tableRecords).toLocaleString()} | ${repLag.toFixed(1)}% |`
		);
		md.push(
			`| **MB/min** | ${checkpointMB.toFixed(1)} | ${results.metrics.clusterWide.table.throughput.mbPerMinute.mean.toFixed(1)} | -${(checkpointMB - results.metrics.clusterWide.table.throughput.mbPerMinute.mean).toFixed(1)} MB | ${repLag.toFixed(1)}% |`
		);
		md.push(
			`| **P50 Latency** | ${(checkpointLatency / 1000).toFixed(2)}s | ${(tableLatency / 1000).toFixed(2)}s | +${(latencyDelta / 1000).toFixed(2)}s | - |`
		);
		md.push('');

		// Analysis
		md.push('### Analysis');
		md.push('');
		if (repLag < 1) {
			md.push('✓ **Excellent replication performance:** Average lag < 1% indicates Harper is replicating data quickly');
		} else if (repLag < 5) {
			md.push('✓ **Good replication performance:** Average lag < 5% shows healthy distributed system performance');
		} else if (repLag < 10) {
			md.push('⚠ **Acceptable replication lag:** Average lag < 10% is acceptable under load');
		} else {
			md.push('⚠ **High replication lag:** Average lag > 10% may indicate bottleneck, investigate cluster performance');
		}
		md.push('');

		// Cluster-Wide Performance
		md.push('---');
		md.push('');
		md.push('## Cluster-Wide Performance');
		md.push('');

		// Checkpoint-based metrics
		md.push('### Checkpoint-Based (Ingestion Speed)');
		md.push('');
		md.push('| Metric | Mean | Median | Min | Max | Std Dev |');
		md.push('|--------|------|--------|-----|-----|---------|');
		md.push(this.formatStatsRow('Records/min', results.metrics.clusterWide.checkpoint.throughput.recordsPerMinute, 0));
		md.push(this.formatStatsRow('MB/min', results.metrics.clusterWide.checkpoint.throughput.mbPerMinute, 1));
		md.push('');

		// Table-based metrics
		md.push('### Table-Based (Query Availability)');
		md.push('');
		md.push('| Metric | Mean | Median | Min | Max | Std Dev |');
		md.push('|--------|------|--------|-----|-----|---------|');
		md.push(this.formatStatsRow('Records/min', results.metrics.clusterWide.table.throughput.recordsPerMinute, 0));
		md.push(this.formatStatsRow('MB/min', results.metrics.clusterWide.table.throughput.mbPerMinute, 1));
		md.push('');

		// Latency
		md.push('### Latency Distribution');
		md.push('');
		md.push('| Metric | P50 (Median) | P95 | P99 |');
		md.push('|--------|--------------|-----|-----|');
		md.push(
			this.formatLatencyRow(
				'Checkpoint Latency',
				results.metrics.clusterWide.checkpoint.latency.p50,
				results.metrics.clusterWide.checkpoint.latency.p95,
				results.metrics.clusterWide.checkpoint.latency.p99
			)
		);
		md.push(
			this.formatLatencyRow(
				'Table Latency',
				results.metrics.clusterWide.table.latency.p50,
				results.metrics.clusterWide.table.latency.p95,
				results.metrics.clusterWide.table.latency.p99
			)
		);
		md.push('');

		// Resource Utilization
		if (results.metrics.resources) {
			md.push('---');
			md.push('');
			md.push('## Resource Utilization');
			md.push('');
			md.push('| Resource | Mean | Peak | Unit |');
			md.push('|----------|------|------|------|');
			md.push(
				`| CPU | ${results.metrics.resources.cpu.mean.toFixed(1)}% | ${results.metrics.resources.cpu.peak.toFixed(1)}% | percent |`
			);
			md.push(
				`| Memory (RSS) | ${results.metrics.resources.memory.rssMean.toFixed(0)} | ${results.metrics.resources.memory.rssPeak.toFixed(0)} | MB |`
			);
			md.push(
				`| Memory (Heap) | ${results.metrics.resources.memory.heapMean.toFixed(0)} | ${results.metrics.resources.memory.heapPeak.toFixed(0)} | MB |`
			);
			md.push('');
		}

		// Phase Breakdown
		md.push('---');
		md.push('');
		md.push('## Phase Breakdown');
		md.push('');
		md.push('| Phase | Duration | Records Ingested | Samples | Status |');
		md.push('|-------|----------|------------------|---------|--------|');
		md.push(
			`| Warmup | ${results.phases.warmup.duration}s | ${(results.phases.warmup.endRecords - results.phases.warmup.startRecords).toLocaleString()} | ${results.phases.warmup.samplesCollected} | ✓ Complete |`
		);
		md.push(
			`| Measurement | ${results.phases.measurement.duration}s | ${(results.phases.measurement.endRecords - results.phases.measurement.startRecords).toLocaleString()} | ${results.phases.measurement.samplesCollected} | ✓ Complete |`
		);
		md.push(
			`| Cooldown | ${results.phases.cooldown.duration}s | ${(results.phases.cooldown.endRecords - results.phases.cooldown.startRecords).toLocaleString()} | ${results.phases.cooldown.samplesCollected} | ✓ Complete |`
		);
		md.push('');

		// Conclusion
		md.push('---');
		md.push('');
		md.push('## Conclusion');
		md.push('');
		md.push('### Key Findings');
		md.push('');
		md.push(`✓ **Sustained throughput:** ${Math.round(checkpointRecords).toLocaleString()} records/min (${checkpointMB.toFixed(1)} MB/min)`);
		md.push(
			`✓ **Replication lag:** ${repLag.toFixed(1)}% average (${repLag < 2 ? 'excellent' : repLag < 5 ? 'good' : 'acceptable'})`
		);
		md.push(`✓ **Median latency:** ${(checkpointLatency / 1000).toFixed(2)}s ingestion, ${(tableLatency / 1000).toFixed(2)}s query availability`);
		md.push('');

		// Footer
		md.push('---');
		md.push('');
		md.push('*Generated by bq-benchmark v1.0.0*');
		md.push('');

		const content = md.join('\n');

		// Write to file if filename provided
		if (filename) {
			writeFileSync(filename, content, 'utf8');
			console.log(`\n✓ Markdown report saved to: ${filename}`);
		}

		return content;
	}

	/**
	 * Format statistics row for markdown table
	 *
	 * @param {string} label - Row label
	 * @param {Object} stats - Statistics object
	 * @param {number} decimals - Number of decimal places
	 * @returns {string} Formatted markdown row
	 * @private
	 */
	static formatStatsRow(label, stats, decimals = 2) {
		const format = (val) => (decimals === 0 ? Math.round(val).toLocaleString() : val.toFixed(decimals));
		return `| **${label}** | ${format(stats.mean)} | ${format(stats.median)} | ${format(stats.min)} | ${format(stats.max)} | ${format(stats.stdDev)} |`;
	}

	/**
	 * Format latency row for markdown table
	 *
	 * @param {string} label - Row label
	 * @param {number} p50 - P50 latency in ms
	 * @param {number} p95 - P95 latency in ms
	 * @param {number} p99 - P99 latency in ms
	 * @returns {string} Formatted markdown row
	 * @private
	 */
	static formatLatencyRow(label, p50, p95, p99) {
		const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;
		return `| ${label} | ${fmt(p50)} | ${fmt(p95)} | ${fmt(p99)} |`;
	}
}
