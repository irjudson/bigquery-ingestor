/**
 * Validation Utilities
 *
 * Pre-flight checks before running benchmarks.
 */

import { CheckpointClient } from '../lib/checkpoint-client.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Validate Harper connectivity
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Validation result with status and message
 */
export async function validateHarperConnectivity(config) {
	try {
		const client = new CheckpointClient(config);
		await client.testConnection();

		return {
			valid: true,
			message: `✓ Harper connectivity verified at ${config.harperUrl}`,
		};
	} catch (error) {
		return {
			valid: false,
			message: `✗ Harper connectivity failed: ${error.message}`,
			error: error,
		};
	}
}

/**
 * Validate BigQuery credentials file exists
 *
 * @param {Object} config - Configuration object
 * @returns {Object} Validation result
 */
export function validateBigQueryCredentials(config) {
	try {
		const credentialsPath = config.bigquery.credentials;

		if (!credentialsPath) {
			return {
				valid: false,
				message: '✗ BigQuery credentials path not specified in config',
			};
		}

		// Resolve path relative to project root (where config.yaml is)
		const resolvedPath = resolve(credentialsPath);

		if (!existsSync(resolvedPath)) {
			return {
				valid: false,
				message: `✗ BigQuery credentials file not found: ${resolvedPath}`,
			};
		}

		// Try to parse as JSON
		try {
			const content = readFileSync(resolvedPath, 'utf8');
			const credentials = JSON.parse(content);

			// Validate it looks like a service account key
			if (!credentials.type || credentials.type !== 'service_account') {
				return {
					valid: false,
					message: '✗ BigQuery credentials file is not a service account key',
				};
			}

			if (!credentials.project_id || !credentials.private_key) {
				return {
					valid: false,
					message: '✗ BigQuery credentials file is missing required fields',
				};
			}

			return {
				valid: true,
				message: `✓ BigQuery credentials verified at ${credentialsPath}`,
				projectId: credentials.project_id,
			};
		} catch (parseError) {
			return {
				valid: false,
				message: `✗ BigQuery credentials file is not valid JSON: ${parseError.message}`,
			};
		}
	} catch (error) {
		return {
			valid: false,
			message: `✗ Error validating BigQuery credentials: ${error.message}`,
			error: error,
		};
	}
}

/**
 * Validate Harper tables exist
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Validation result
 */
export async function validateHarperTables(config) {
	try {
		const client = new CheckpointClient(config);
		const results = [];
		let allValid = true;

		for (const table of config.bigquery.tables) {
			try {
				// Try to query the table to see if it exists
				const count = await client.getTableRecordCount(table.targetTable);
				results.push({
					tableId: table.id,
					targetTable: table.targetTable,
					valid: true,
					recordCount: count,
					message: `✓ ${table.targetTable} (${count} records)`,
				});
			} catch (error) {
				allValid = false;
				results.push({
					tableId: table.id,
					targetTable: table.targetTable,
					valid: false,
					message: `✗ ${table.targetTable} - ${error.message}`,
				});
			}
		}

		return {
			valid: allValid,
			message: allValid
				? `✓ All ${results.length} Harper tables verified`
				: `✗ Some Harper tables are missing or inaccessible`,
			tables: results,
		};
	} catch (error) {
		return {
			valid: false,
			message: `✗ Error validating Harper tables: ${error.message}`,
			error: error,
		};
	}
}

/**
 * Validate SyncCheckpoint table has data
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Validation result
 */
export async function validateSyncCheckpoints(config) {
	try {
		const client = new CheckpointClient(config);
		const checkpoints = await client.getAll();

		if (checkpoints.length === 0) {
			return {
				valid: false,
				message: '✗ No checkpoint data found. Is the sync running?',
				hint: 'Start Harper sync: harper dev .',
			};
		}

		// Check that we have checkpoints for configured tables
		const tableIds = config.bigquery.tables.map((t) => t.id);
		const checkpointTableIds = [...new Set(checkpoints.map((cp) => cp.tableId))];

		const missingTables = tableIds.filter((id) => !checkpointTableIds.includes(id));

		if (missingTables.length > 0) {
			return {
				valid: false,
				message: `✗ Missing checkpoints for tables: ${missingTables.join(', ')}`,
				hint: 'Ensure sync is running for all configured tables',
			};
		}

		return {
			valid: true,
			message: `✓ Found ${checkpoints.length} checkpoints across ${checkpointTableIds.length} tables`,
			checkpointCount: checkpoints.length,
			tableCount: checkpointTableIds.length,
		};
	} catch (error) {
		return {
			valid: false,
			message: `✗ Error validating sync checkpoints: ${error.message}`,
			error: error,
		};
	}
}

/**
 * Run all pre-flight validations
 *
 * @param {Object} config - Configuration object
 * @param {Object} [options] - Validation options
 * @param {boolean} [options.skipBigQuery] - Skip BigQuery validation
 * @param {boolean} [options.skipTables] - Skip table existence checks
 * @param {boolean} [options.skipCheckpoints] - Skip checkpoint validation
 * @returns {Promise<Object>} Combined validation result
 */
export async function runPreFlightValidation(config, options = {}) {
	const results = {
		valid: true,
		checks: [],
		errors: [],
	};

	// 1. Validate Harper connectivity (always required)
	const harperCheck = await validateHarperConnectivity(config);
	results.checks.push(harperCheck);
	if (!harperCheck.valid) {
		results.valid = false;
		results.errors.push(harperCheck.message);
	}

	// 2. Validate BigQuery credentials (unless skipped)
	if (!options.skipBigQuery) {
		const bqCheck = validateBigQueryCredentials(config);
		results.checks.push(bqCheck);
		if (!bqCheck.valid) {
			results.valid = false;
			results.errors.push(bqCheck.message);
		}
	}

	// 3. Validate Harper tables exist (unless skipped)
	if (!options.skipTables && harperCheck.valid) {
		const tablesCheck = await validateHarperTables(config);
		results.checks.push(tablesCheck);
		if (!tablesCheck.valid) {
			results.valid = false;
			results.errors.push(tablesCheck.message);
		}
	}

	// 4. Validate sync checkpoints (unless skipped)
	if (!options.skipCheckpoints && harperCheck.valid) {
		const checkpointsCheck = await validateSyncCheckpoints(config);
		results.checks.push(checkpointsCheck);
		if (!checkpointsCheck.valid) {
			results.valid = false;
			results.errors.push(checkpointsCheck.message);
		}
	}

	return results;
}

/**
 * Format validation results for console output
 *
 * @param {Object} results - Validation results from runPreFlightValidation
 * @returns {string} Formatted output
 */
export function formatValidationResults(results) {
	let output = '\n';

	for (const check of results.checks) {
		output += check.message + '\n';

		// Show additional details if available
		if (check.tables) {
			for (const table of check.tables) {
				output += `  ${table.message}\n`;
			}
		}

		// Show hints if available
		if (check.hint) {
			output += `  Hint: ${check.hint}\n`;
		}
	}

	if (!results.valid) {
		output += '\n❌ Pre-flight validation failed. Please fix the errors above.\n';
	} else {
		output += '\n✅ All pre-flight checks passed. Ready to benchmark.\n';
	}

	return output;
}
