#!/usr/bin/env node

/**
 * BigQuery → Harper Benchmark CLI
 *
 * Measures sustained throughput from BigQuery to Harper with sliding window algorithm.
 */

import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { runCommand } from './commands/run.js';
import { analyzeCommand } from './commands/analyze.js';
import { cleanupCommand } from './commands/cleanup.js';

const program = new Command();

program
	.name('bq-benchmark')
	.description('BigQuery to Harper throughput benchmarking tool')
	.version('1.0.0');

// Setup command
program
	.command('setup')
	.description('Prepare the environment for benchmarking')
	.option('--vessels <number>', 'Number of vessels to generate', '100000')
	.option('--dataset <name>', 'BigQuery dataset name', 'maritime_tracking')
	.option('--skip-cleanup', "Don't clean up existing benchmark data")
	.option('--verify', 'Verify BigQuery and Harper connectivity')
	.action(setupCommand);

// Run command
program
	.command('run')
	.description('Execute the benchmark')
	.option('--warmup <seconds>', 'Warmup phase duration', '120')
	.option('--measure <seconds>', 'Measurement phase duration', '300')
	.option('--cooldown <seconds>', 'Cooldown phase duration', '60')
	.option('--sample-interval <seconds>', 'Checkpoint sampling interval', '5')
	.option('--output <format>', 'Display format: live|logs', 'live')
	.option('--report-file <path>', 'Report filename')
	.option('--json', 'Also generate JSON report')
	.option('--csv', 'Also generate CSV files')
	.option('--no-graphs', 'Disable ASCII graphs in markdown')
	.option('--tables <ids>', 'Comma-separated table IDs to benchmark')
	.option('--skip-warmup', 'Skip warmup phase (debugging only)')
	.option('--profile', 'Enable resource profiling')
	.option('--verbose', 'Enable detailed logging')
	.action(runCommand);

// Analyze command
program
	.command('analyze <report-file>')
	.description('Analyze a previous benchmark run')
	.option('--compare <file2>', 'Compare two benchmark runs')
	.option('--format <type>', 'Output format: json|csv|markdown', 'markdown')
	.option('--percentiles <list>', 'Latency percentiles to calculate', '50,95,99')
	.action(analyzeCommand);

// Cleanup command
program
	.command('cleanup')
	.description('Remove benchmark data')
	.option('--bigquery', 'Delete BigQuery test data')
	.option('--harper', 'Delete Harper test data')
	.option('--all', 'Delete both BigQuery and Harper data', true)
	.option('--keep-reports', "Don't delete benchmark report files")
	.action(cleanupCommand);

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
	program.outputHelp();
}
