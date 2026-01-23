/**
 * Benchmark Runner
 *
 * Main orchestrator that coordinates the entire benchmark:
 * - Pre-flight validation
 * - Three-phase execution (warmup, measurement, cooldown)
 * - Metrics calculation
 * - Report generation
 */

import { MetricsCollector } from './metrics-collector.js';
import { PhaseManager } from './phase-manager.js';
import { SlidingWindow } from './sliding-window.js';
import { ResourceMonitor } from './resource-monitor.js';
import { runPreFlightValidation, formatValidationResults } from '../utils/validation.js';

export class BenchmarkRunner {
	/**
	 * Create a new BenchmarkRunner
	 *
	 * @param {Object} config - Configuration object
	 */
	constructor(config) {
		this.config = config;
		this.metricsCollector = new MetricsCollector(config);
		this.phaseManager = new PhaseManager(
			{
				warmupSeconds: config.warmupSeconds || config.benchmarkDefaults?.warmupSeconds || 120,
				measureSeconds: config.measureSeconds || config.benchmarkDefaults?.measureSeconds || 300,
				cooldownSeconds: config.cooldownSeconds || config.benchmarkDefaults?.cooldownSeconds || 60,
				sampleInterval: config.sampleInterval || config.benchmarkDefaults?.sampleInterval || 5,
			},
			null // No live reporter for MVP
		);
		this.resourceMonitor = config.profile ? new ResourceMonitor() : null;
		this.benchmarkId = this.generateBenchmarkId();
	}

	/**
	 * Run the complete benchmark
	 *
	 * @returns {Promise<Object>} Benchmark results
	 */
	async run() {
		console.log('\n🚀 BigQuery → Harper Benchmark\n');
		console.log(`Benchmark ID: ${this.benchmarkId}`);
		console.log(`Started: ${new Date().toISOString()}\n`);

		// Pre-flight validation
		console.log('Running pre-flight validation...\n');
		const validationResults = await runPreFlightValidation(this.config);
		console.log(formatValidationResults(validationResults));

		if (!validationResults.valid) {
			throw new Error('Pre-flight validation failed. Cannot start benchmark.');
		}

		// Start resource monitoring if enabled
		if (this.resourceMonitor) {
			this.resourceMonitor.start();
		}

		const startTime = Date.now();

		try {
			// Phase 1: Warmup
			console.log('═'.repeat(60));
			const warmupSamples = await this.phaseManager.runWarmup(async () => {
				const sample = await this.metricsCollector.sample();
				if (this.resourceMonitor) {
					this.resourceMonitor.sample();
				}
				return sample;
			});

			// Mark start of measurement
			this.metricsCollector.startMeasurement();

			// Phase 2: Measurement
			console.log('═'.repeat(60));
			const measurementSamples = await this.phaseManager.runMeasurement(async () => {
				const sample = await this.metricsCollector.sample();
				if (this.resourceMonitor) {
					this.resourceMonitor.sample();
				}
				return sample;
			});

			// Phase 3: Cooldown
			console.log('═'.repeat(60));
			const cooldownSamples = await this.phaseManager.runCooldown(async () => {
				const sample = await this.metricsCollector.sample();
				if (this.resourceMonitor) {
					this.resourceMonitor.sample();
				}
				return sample;
			});

			console.log('═'.repeat(60));

			// Calculate final metrics
			console.log('\n📈 Calculating metrics...');
			const metrics = this.calculateMetrics(measurementSamples);

			const endTime = Date.now();
			const totalDuration = (endTime - startTime) / 1000;

			console.log('✓ Metrics calculated\n');

			// Build results object
			const results = {
				benchmark: {
					id: this.benchmarkId,
					startTime: new Date(startTime).toISOString(),
					endTime: new Date(endTime).toISOString(),
					totalDuration: totalDuration,
					version: '1.0.0',
				},
				configuration: {
					warmupSeconds: this.phaseManager.config.warmupSeconds,
					measureSeconds: this.phaseManager.config.measureSeconds,
					cooldownSeconds: this.phaseManager.config.cooldownSeconds,
					sampleInterval: this.phaseManager.config.sampleInterval,
					tables: this.config.bigquery.tables.map((t) => t.id),
					cluster: {
						harperUrl: this.config.harperUrl,
					},
					profile: !!this.resourceMonitor,
				},
				phases: {
					warmup: {
						duration: this.phaseManager.config.warmupSeconds,
						samplesCollected: warmupSamples.length,
						startRecords: warmupSamples[0]?.checkpoint.totalRecords || 0,
						endRecords: warmupSamples[warmupSamples.length - 1]?.checkpoint.totalRecords || 0,
					},
					measurement: {
						duration: this.phaseManager.config.measureSeconds,
						samplesCollected: measurementSamples.length,
						startRecords: measurementSamples[0]?.checkpoint.totalRecords || 0,
						endRecords: measurementSamples[measurementSamples.length - 1]?.checkpoint.totalRecords || 0,
					},
					cooldown: {
						duration: this.phaseManager.config.cooldownSeconds,
						samplesCollected: cooldownSamples.length,
						startRecords: cooldownSamples[0]?.checkpoint.totalRecords || 0,
						endRecords: cooldownSamples[cooldownSamples.length - 1]?.checkpoint.totalRecords || 0,
					},
				},
				metrics: metrics,
				samples: measurementSamples, // Include raw samples for analysis
			};

			return results;
		} catch (error) {
			console.error(`\n❌ Benchmark failed: ${error.message}\n`);
			throw error;
		}
	}

	/**
	 * Calculate metrics from measurement samples
	 *
	 * @param {Array} samples - Measurement phase samples
	 * @returns {Object} Calculated metrics
	 * @private
	 */
	calculateMetrics(samples) {
		const window = new SlidingWindow(samples);
		const allMetrics = window.getAllMetrics();

		return {
			clusterWide: {
				checkpoint: {
					throughput: allMetrics.throughput.checkpoint,
					latency: allMetrics.latency.checkpoint,
				},
				table: {
					throughput: allMetrics.throughput.table,
					latency: allMetrics.latency.table,
				},
				replicationLag: allMetrics.replicationLag,
			},
			resources: this.resourceMonitor ? this.resourceMonitor.getStatistics() : null,
			sampleCount: allMetrics.sampleCount,
			duration: allMetrics.duration,
		};
	}

	/**
	 * Generate a unique benchmark ID
	 *
	 * @returns {string} Benchmark ID
	 * @private
	 */
	generateBenchmarkId() {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
		const random = Math.random().toString(36).substring(2, 6);
		return `bench_${timestamp}_${random}`;
	}
}
