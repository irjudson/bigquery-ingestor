/**
 * Config Loader for bq-benchmark
 *
 * Wraps the main project's config loader and adds benchmark-specific settings.
 */

import { loadConfig as loadMainConfig } from '../../../src/config-loader.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load and prepare configuration for benchmarking
 *
 * @param {string} [configPath] - Optional path to config file (defaults to project config.yaml)
 * @returns {Object} Configuration with benchmark-specific additions
 * @throws {Error} If configuration cannot be loaded or is invalid
 */
export function loadBenchmarkConfig(configPath = null) {
	// Default to project root config.yaml
	const defaultPath = configPath || join(__dirname, '../../../config.yaml');

	try {
		// Load and normalize config using main project's loader
		const config = loadMainConfig(defaultPath);

		// Validate required sections for benchmarking
		validateBenchmarkConfig(config);

		// Add benchmark-specific settings
		const benchmarkConfig = {
			...config,

			// Harper connection settings
			harperUrl: `http://${config.operations.host}:${config.operations.port}`,
			harperAuth: Buffer.from(`${config.operations.username}:${config.operations.password}`).toString('base64'),

			// BigQuery project info
			bigqueryProject: config.bigquery.projectId,
			bigqueryDataset: config.bigquery.tables?.[0]?.dataset || config.bigquery.dataset,

			// Default benchmark timing (can be overridden by CLI flags)
			benchmarkDefaults: {
				warmupSeconds: 120,
				measureSeconds: 300,
				cooldownSeconds: 60,
				sampleInterval: 5,
			},
		};

		return benchmarkConfig;
	} catch (error) {
		throw new Error(`Failed to load benchmark configuration: ${error.message}`);
	}
}

/**
 * Validate configuration has required fields for benchmarking
 *
 * @param {Object} config - Configuration object
 * @throws {Error} If required fields are missing
 * @private
 */
function validateBenchmarkConfig(config) {
	// Validate operations section (required for Harper connectivity)
	if (!config.operations) {
		throw new Error('Missing required "operations" section in config for Harper connectivity');
	}

	const requiredOperationsFields = ['host', 'port', 'username', 'password'];
	for (const field of requiredOperationsFields) {
		if (!config.operations[field]) {
			throw new Error(`Missing required field "operations.${field}" in config`);
		}
	}

	// Validate bigquery section
	if (!config.bigquery) {
		throw new Error('Missing required "bigquery" section in config');
	}

	if (!config.bigquery.projectId) {
		throw new Error('Missing required field "bigquery.projectId" in config');
	}

	// Validate tables configuration
	if (!config.bigquery.tables || !Array.isArray(config.bigquery.tables) || config.bigquery.tables.length === 0) {
		throw new Error('No tables configured in "bigquery.tables"');
	}

	// Validate each table has required fields
	for (const table of config.bigquery.tables) {
		if (!table.id) {
			throw new Error('Table configuration missing required "id" field');
		}
		if (!table.targetTable) {
			throw new Error(`Table "${table.id}" missing required "targetTable" field`);
		}
		if (!table.timestampColumn) {
			throw new Error(`Table "${table.id}" missing required "timestampColumn" field`);
		}
	}
}

/**
 * Get list of table IDs from configuration
 *
 * @param {Object} config - Configuration object
 * @returns {string[]} Array of table IDs
 */
export function getTableIds(config) {
	return config.bigquery.tables.map((table) => table.id);
}

/**
 * Get table configuration by ID
 *
 * @param {Object} config - Configuration object
 * @param {string} tableId - Table ID to find
 * @returns {Object|null} Table configuration or null if not found
 */
export function getTableConfig(config, tableId) {
	return config.bigquery.tables.find((table) => table.id === tableId) || null;
}
