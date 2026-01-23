/**
 * Checkpoint Client
 *
 * Interface to Harper SyncCheckpoint table via REST API.
 * Provides checkpoint-based metrics (ingestion throughput).
 */

import fetch from 'node-fetch';

export class CheckpointClient {
	/**
	 * Create a new CheckpointClient
	 *
	 * @param {Object} config - Configuration object
	 * @param {string} config.harperUrl - Harper base URL (e.g., http://localhost:9926)
	 * @param {string} config.harperAuth - Base64 encoded Basic auth credentials
	 */
	constructor(config) {
		if (!config.harperUrl) {
			throw new Error('CheckpointClient requires config.harperUrl');
		}
		if (!config.harperAuth) {
			throw new Error('CheckpointClient requires config.harperAuth');
		}

		this.baseUrl = config.harperUrl;
		this.auth = `Basic ${config.harperAuth}`;
	}

	/**
	 * Query all checkpoints from SyncCheckpoint table
	 *
	 * @returns {Promise<Array>} Array of checkpoint objects
	 * @throws {Error} If query fails
	 */
	async getAll() {
		try {
			const url = `${this.baseUrl}/SyncCheckpoint/`;

			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: this.auth,
					'Content-Type': 'application/json',
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to query checkpoints: ${response.status} ${response.statusText} - ${errorText}`);
			}

			const checkpoints = await response.json();

			// Validate response is an array
			if (!Array.isArray(checkpoints)) {
				throw new Error('Expected array of checkpoints but received: ' + typeof checkpoints);
			}

			return checkpoints;
		} catch (error) {
			if (error.code === 'ECONNREFUSED') {
				throw new Error(`Cannot connect to Harper at ${this.baseUrl}. Is Harper running?`);
			}
			throw error;
		}
	}

	/**
	 * Query checkpoints for a specific table
	 *
	 * @param {string} tableId - Table ID to filter by
	 * @returns {Promise<Array>} Array of checkpoint objects for the table
	 * @throws {Error} If query fails
	 */
	async getByTable(tableId) {
		try {
			// Use SQL query to filter by tableId
			const sql = `SELECT * FROM SyncCheckpoint WHERE tableId = '${tableId}'`;

			const response = await fetch(this.baseUrl, {
				method: 'POST',
				headers: {
					Authorization: this.auth,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ sql }),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Failed to query checkpoints for table ${tableId}: ${response.status} ${response.statusText} - ${errorText}`
				);
			}

			const result = await response.json();

			// Validate response is an array
			if (!Array.isArray(result)) {
				throw new Error('Expected array of checkpoints but received: ' + typeof result);
			}

			return result;
		} catch (error) {
			if (error.code === 'ECONNREFUSED') {
				throw new Error(`Cannot connect to Harper at ${this.baseUrl}. Is Harper running?`);
			}
			throw error;
		}
	}

	/**
	 * Query record count from data table (for table-based metrics)
	 *
	 * @param {string} tableName - Name of the data table (e.g., VesselPositions)
	 * @param {Date} [beforeTimestamp] - Optional cutoff timestamp
	 * @returns {Promise<number>} Record count
	 * @throws {Error} If query fails
	 */
	async getTableRecordCount(tableName, beforeTimestamp = null) {
		try {
			let sql;
			if (beforeTimestamp) {
				const timestamp = beforeTimestamp.toISOString();
				sql = `SELECT COUNT(*) as count FROM ${tableName} WHERE _syncedAt <= '${timestamp}'`;
			} else {
				sql = `SELECT COUNT(*) as count FROM ${tableName}`;
			}

			const response = await fetch(this.baseUrl, {
				method: 'POST',
				headers: {
					Authorization: this.auth,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ sql }),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Failed to query record count for table ${tableName}: ${response.status} ${response.statusText} - ${errorText}`
				);
			}

			const result = await response.json();

			if (!Array.isArray(result) || result.length === 0) {
				return 0;
			}

			return result[0].count || 0;
		} catch (error) {
			if (error.code === 'ECONNREFUSED') {
				throw new Error(`Cannot connect to Harper at ${this.baseUrl}. Is Harper running?`);
			}
			// If table doesn't exist yet, return 0
			if (error.message.includes('does not exist') || error.message.includes('not found')) {
				return 0;
			}
			throw error;
		}
	}

	/**
	 * Sample records from a table to estimate average record size
	 *
	 * @param {string} tableName - Name of the data table
	 * @param {number} [sampleSize=100] - Number of records to sample
	 * @returns {Promise<Array>} Sample records
	 * @throws {Error} If query fails
	 */
	async sampleRecords(tableName, sampleSize = 100) {
		try {
			const url = `${this.baseUrl}/${tableName}/?limit=${sampleSize}`;

			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: this.auth,
					'Content-Type': 'application/json',
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Failed to sample records from ${tableName}: ${response.status} ${response.statusText} - ${errorText}`
				);
			}

			const records = await response.json();

			if (!Array.isArray(records)) {
				return [];
			}

			return records;
		} catch (error) {
			if (error.code === 'ECONNREFUSED') {
				throw new Error(`Cannot connect to Harper at ${this.baseUrl}. Is Harper running?`);
			}
			// If table doesn't exist yet or has no data, return empty array
			if (error.message.includes('does not exist') || error.message.includes('not found')) {
				return [];
			}
			throw error;
		}
	}

	/**
	 * Test connectivity to Harper
	 *
	 * @returns {Promise<boolean>} True if connection successful
	 * @throws {Error} If connection fails
	 */
	async testConnection() {
		try {
			// Try to query SyncCheckpoint table
			await this.getAll();
			return true;
		} catch (error) {
			throw new Error(`Harper connectivity test failed: ${error.message}`);
		}
	}
}
