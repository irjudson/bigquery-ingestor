/**
 * Run Command
 *
 * Executes the benchmark with three phases (warmup, measurement, cooldown).
 */

import { loadBenchmarkConfig } from '../utils/config-loader.js';
import { BenchmarkRunner } from '../lib/benchmark-runner.js';
import { MarkdownReporter } from '../reporters/markdown-reporter.js';
import { resolve } from 'path';

export async function runCommand(options) {
	try {
		// Load configuration
		const config = loadBenchmarkConfig();

		// Apply CLI options to config
		if (options.warmup) {
			config.warmupSeconds = parseInt(options.warmup, 10);
		}
		if (options.measure) {
			config.measureSeconds = parseInt(options.measure, 10);
		}
		if (options.cooldown) {
			config.cooldownSeconds = parseInt(options.cooldown, 10);
		}
		if (options.sampleInterval) {
			config.sampleInterval = parseInt(options.sampleInterval, 10);
		}
		if (options.profile) {
			config.profile = true;
		}

		// TODO: Filter tables if --tables option provided
		// if (options.tables) {
		//   const tableIds = options.tables.split(',');
		//   config.bigquery.tables = config.bigquery.tables.filter(t => tableIds.includes(t.id));
		// }

		// Create and run benchmark
		const runner = new BenchmarkRunner(config);
		const results = await runner.run();

		// Generate report filename
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const defaultFilename = `benchmark-report-${timestamp}.md`;
		const reportFile = options.reportFile ? resolve(options.reportFile) : resolve(defaultFilename);

		// Generate markdown report (default)
		console.log('📝 Generating reports...\n');
		MarkdownReporter.generate(results, reportFile);

		// Generate JSON report if requested
		if (options.json) {
			const jsonFile = reportFile.replace('.md', '.json');
			const { writeFileSync } = await import('fs');
			writeFileSync(jsonFile, JSON.stringify(results, null, 2), 'utf8');
			console.log(`✓ JSON report saved to: ${jsonFile}`);
		}

		// Generate CSV reports if requested
		if (options.csv) {
			console.log('⚠️  CSV export not yet implemented (coming soon)');
		}

		// Display summary
		console.log('\n' + '═'.repeat(60));
		console.log('✅ Benchmark Complete!\n');

		const checkpointRecords = results.metrics.clusterWide.checkpoint.throughput.recordsPerMinute.mean;
		const checkpointMB = results.metrics.clusterWide.checkpoint.throughput.mbPerMinute.mean;
		const repLag = results.metrics.clusterWide.replicationLag.percentLag.mean;

		console.log('📊 Summary:');
		console.log(`   Records/min: ${Math.round(checkpointRecords).toLocaleString()}`);
		console.log(`   MB/min: ${checkpointMB.toFixed(1)}`);
		console.log(`   Replication lag: ${repLag.toFixed(1)}%`);
		console.log(`   Duration: ${Math.floor(results.benchmark.totalDuration / 60)} minutes\n`);

		console.log(`📄 Full report: ${reportFile}\n`);
	} catch (error) {
		console.error(`\n❌ Benchmark failed: ${error.message}\n`);
		if (options.verbose) {
			console.error(error.stack);
		}
		process.exit(1);
	}
}
