/**
 * Metrics Collector
 *
 * Samples checkpoints and data tables to collect throughput metrics.
 * Provides both checkpoint-based (ingestion) and table-based (query availability) metrics.
 */

import { CheckpointClient } from './checkpoint-client.js';

export class MetricsCollector {
	/**
	 * Create a new MetricsCollector
	 *
	 * @param {Object} config - Configuration object
	 */
	constructor(config) {
		this.config = config;
		this.checkpointClient = new CheckpointClient(config);
		this.recordSizeCache = new Map(); // Cache avg record sizes per table
		this.measurementStartTime = null; // Track when measurement phase starts
	}

	/**
	 * Collect one sample (checkpoints + table counts + resources)
	 *
	 * @returns {Promise<Object>} Sample object with all metrics
	 */
	async sample() {
		const timestamp = new Date();

		// 1. Query checkpoints (checkpoint-based metrics)
		const checkpoints = await this.checkpointClient.getAll();

		// 2. Aggregate by table
		const byTable = this.aggregateByTable(checkpoints);

		// 3. Calculate total records from checkpoints
		const checkpointRecords = checkpoints.reduce((sum, cp) => sum + (cp.recordsIngested || 0), 0);

		// 4. Estimate total bytes
		const checkpointBytes = await this.estimateBytes(checkpoints);

		// 5. Query data tables for table-based metrics
		const tableRecords = await this.queryTableCounts(timestamp);

		// 6. Calculate replication lag
		const replicationLag = this.calculateReplicationLag(checkpointRecords, tableRecords);

		// 7. Collect resource utilization (if profiling enabled)
		const resources = this.config.profile ? this.sampleResources() : null;

		return {
			timestamp,
			checkpoints,
			byTable,
			checkpoint: {
				totalRecords: checkpointRecords,
				totalBytes: checkpointBytes,
			},
			table: {
				totalRecords: tableRecords,
			},
			replicationLag,
			resources,
		};
	}

	/**
	 * Aggregate checkpoints by table
	 *
	 * @param {Array} checkpoints - Array of checkpoint objects
	 * @returns {Array} Aggregated by table
	 * @private
	 */
	aggregateByTable(checkpoints) {
		const byTable = new Map();

		for (const cp of checkpoints) {
			if (!byTable.has(cp.tableId)) {
				byTable.set(cp.tableId, {
					tableId: cp.tableId,
					targetTable: this.getTargetTableName(cp.tableId),
					recordsIngested: 0,
					nodes: [],
					latestTimestamp: null,
				});
			}

			const table = byTable.get(cp.tableId);
			table.recordsIngested += cp.recordsIngested || 0;
			table.nodes.push(cp.nodeId);

			// Track latest timestamp
			if (cp.lastTimestamp) {
				const cpTime = new Date(cp.lastTimestamp);
				if (!table.latestTimestamp || cpTime > table.latestTimestamp) {
					table.latestTimestamp = cpTime;
				}
			}
		}

		return Array.from(byTable.values());
	}

	/**
	 * Estimate total bytes from checkpoints
	 *
	 * @param {Array} checkpoints - Array of checkpoint objects
	 * @returns {Promise<number>} Estimated total bytes
	 * @private
	 */
	async estimateBytes(checkpoints) {
		let totalBytes = 0;

		// Group by table to avoid redundant size sampling
		const byTable = new Map();
		for (const cp of checkpoints) {
			if (!byTable.has(cp.tableId)) {
				byTable.set(cp.tableId, 0);
			}
			byTable.set(cp.tableId, byTable.get(cp.tableId) + (cp.recordsIngested || 0));
		}

		// Calculate bytes per table
		for (const [tableId, recordCount] of byTable.entries()) {
			const avgSize = await this.getRecordSize(tableId);
			totalBytes += recordCount * avgSize;
		}

		return totalBytes;
	}

	/**
	 * Get average record size for a table (cached)
	 *
	 * @param {string} tableId - Table ID
	 * @returns {Promise<number>} Average record size in bytes
	 * @private
	 */
	async getRecordSize(tableId) {
		if (this.recordSizeCache.has(tableId)) {
			return this.recordSizeCache.get(tableId);
		}

		// Sample records to estimate size
		const targetTable = this.getTargetTableName(tableId);
		const avgSize = await this.sampleRecordSize(targetTable);
		this.recordSizeCache.set(tableId, avgSize);

		return avgSize;
	}

	/**
	 * Sample records from a table to estimate average size
	 *
	 * @param {string} tableName - Harper table name
	 * @param {number} [sampleSize=100] - Number of records to sample
	 * @returns {Promise<number>} Average record size in bytes
	 * @private
	 */
	async sampleRecordSize(tableName, sampleSize = 100) {
		try {
			const records = await this.checkpointClient.sampleRecords(tableName, sampleSize);

			if (records.length === 0) {
				// Default size if no data yet
				return 256; // bytes
			}

			// Calculate average byte size
			const totalSize = records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);

			return totalSize / records.length;
		} catch (error) {
			// If sampling fails, use default size
			console.warn(`Warning: Failed to sample record size for ${tableName}: ${error.message}, using default`);
			return 256; // bytes
		}
	}

	/**
	 * Query record counts from data tables (table-based metrics)
	 *
	 * @param {Date} timestamp - Current timestamp
	 * @returns {Promise<number>} Total queryable records
	 * @private
	 */
	async queryTableCounts(timestamp) {
		let totalRecords = 0;

		for (const tableConfig of this.config.bigquery.tables) {
			try {
				const count = await this.checkpointClient.getTableRecordCount(tableConfig.targetTable, timestamp);
				totalRecords += count;
			} catch (error) {
				console.warn(`Warning: Failed to query count for ${tableConfig.targetTable}: ${error.message}`);
				// Continue with other tables
			}
		}

		return totalRecords;
	}

	/**
	 * Calculate replication lag between checkpoint and table metrics
	 *
	 * @param {number} checkpointRecords - Records from checkpoints
	 * @param {number} tableRecords - Records from data tables
	 * @returns {Object} Replication lag statistics
	 * @private
	 */
	calculateReplicationLag(checkpointRecords, tableRecords) {
		if (checkpointRecords === 0) {
			return {
				recordDelta: 0,
				percentLag: 0,
			};
		}

		const recordDelta = checkpointRecords - tableRecords;
		const percentLag = (recordDelta / checkpointRecords) * 100;

		return {
			recordDelta,
			percentLag: Math.max(0, percentLag), // Don't allow negative lag
		};
	}

	/**
	 * Sample system resources (CPU, memory, network)
	 *
	 * @returns {Object} Resource usage snapshot
	 * @private
	 */
	sampleResources() {
		const usage = process.cpuUsage();
		const memory = process.memoryUsage();

		return {
			cpu: {
				user: usage.user,
				system: usage.system,
			},
			memory: {
				rss: memory.rss,
				heapTotal: memory.heapTotal,
				heapUsed: memory.heapUsed,
				external: memory.external,
			},
			// Note: Network I/O requires OS-specific calls, skipping for MVP
		};
	}

	/**
	 * Get target Harper table name for a table ID
	 *
	 * @param {string} tableId - Table ID from config
	 * @returns {string} Target table name
	 * @private
	 */
	getTargetTableName(tableId) {
		const tableConfig = this.config.bigquery.tables.find((t) => t.id === tableId);
		return tableConfig ? tableConfig.targetTable : tableId;
	}

	/**
	 * Mark the start of measurement phase
	 * Used for calculating metrics within measurement window only
	 */
	startMeasurement() {
		this.measurementStartTime = new Date();
	}

	/**
	 * Reset collector state (e.g., between benchmark runs)
	 */
	reset() {
		this.recordSizeCache.clear();
		this.measurementStartTime = null;
	}
}
