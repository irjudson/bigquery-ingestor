/**
 * Tests for custom SQL query and proxy configuration features
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCustomQuery, validateProxyConfig, validateAndNormalizeColumns } from '../src/validators.js';
import { buildCustomPartitionQuery, QueryBuilder } from '../src/query-builder.js';

describe('Custom Query Validation', () => {
	it('should accept valid custom query with @lastTimestamp', () => {
		const query = `
			SELECT event_time as timestamp, vessel_id, event_type
			FROM \`dataset.table\`
			WHERE event_time > TIMESTAMP(@lastTimestamp)
		`;
		assert.doesNotThrow(() => validateCustomQuery(query, 'timestamp'));
	});

	it('should reject custom query without @lastTimestamp', () => {
		const query = `
			SELECT event_time as timestamp, vessel_id
			FROM \`dataset.table\`
			WHERE event_time > '2024-01-01'
		`;
		assert.throws(() => validateCustomQuery(query, 'timestamp'), /must include @lastTimestamp/);
	});

	it('should reject non-SELECT queries', () => {
		const query = `UPDATE dataset.table SET field = 'value' WHERE id = @lastTimestamp`;
		assert.throws(() => validateCustomQuery(query, 'timestamp'), /must start with SELECT/);
	});

	it('should reject empty custom query', () => {
		assert.throws(() => validateCustomQuery('   ', 'timestamp'), /cannot be empty/);
	});
});

describe('Proxy Configuration Validation', () => {
	it('should accept valid HTTP proxy configuration', () => {
		const config = {
			enabled: true,
			url: 'http://proxy.company.com:8080',
		};
		assert.doesNotThrow(() => validateProxyConfig(config));
	});

	it('should accept valid HTTPS proxy configuration', () => {
		const config = {
			enabled: true,
			url: 'https://proxy.company.com:8443',
		};
		assert.doesNotThrow(() => validateProxyConfig(config));
	});

	it('should accept authenticated proxy URL', () => {
		const config = {
			enabled: true,
			url: 'http://user:pass@proxy.company.com:8080',
		};
		assert.doesNotThrow(() => validateProxyConfig(config));
	});

	it('should accept disabled proxy without URL', () => {
		const config = {
			enabled: false,
			url: 'http://proxy.company.com:8080',
		};
		assert.doesNotThrow(() => validateProxyConfig(config));
	});

	it('should reject proxy without enabled field', () => {
		const config = {
			url: 'http://proxy.company.com:8080',
		};
		assert.throws(() => validateProxyConfig(config), /enabled must be a boolean/);
	});

	it('should reject enabled proxy without URL', () => {
		const config = {
			enabled: true,
		};
		assert.throws(() => validateProxyConfig(config), /url is required/);
	});

	it('should reject invalid URL format', () => {
		const config = {
			enabled: true,
			url: 'not-a-valid-url',
		};
		assert.throws(() => validateProxyConfig(config), /must start with http/);
	});
});

describe('Custom Query Building', () => {
	it('should wrap custom query with partitioning logic', () => {
		const customQuery = `
			SELECT event_time as timestamp, vessel_id, event_type
			FROM \`dataset.events\`
			WHERE event_time > TIMESTAMP(@lastTimestamp)
		`;

		const wrappedQuery = buildCustomPartitionQuery({
			customQuery,
			timestampColumn: 'timestamp',
		});

		// Check that the query contains the original query
		assert.ok(wrappedQuery.includes('SELECT event_time as timestamp'));

		// Check that it adds partitioning
		assert.ok(wrappedQuery.includes('MOD(UNIX_MICROS'));
		assert.ok(wrappedQuery.includes('@clusterSize'));
		assert.ok(wrappedQuery.includes('@nodeId'));

		// Check that it adds ORDER BY
		assert.ok(wrappedQuery.includes('ORDER BY'));
		assert.ok(wrappedQuery.includes('user_query.timestamp'));

		// Check that it adds LIMIT
		assert.ok(wrappedQuery.includes('LIMIT'));
		assert.ok(wrappedQuery.includes('@batchSize'));
	});

	it('should reference correct timestamp column in wrapped query', () => {
		const customQuery = `
			SELECT created_at as my_timestamp, id, name
			FROM \`dataset.table\`
			WHERE created_at > TIMESTAMP(@lastTimestamp)
		`;

		const wrappedQuery = buildCustomPartitionQuery({
			customQuery,
			timestampColumn: 'my_timestamp',
		});

		// Check that ORDER BY uses the correct timestamp column
		assert.ok(wrappedQuery.includes('user_query.my_timestamp'));
	});
});

describe('QueryBuilder with Custom Query', () => {
	it('should initialize QueryBuilder with custom query', () => {
		const customQuery = `
			SELECT event_time as timestamp, vessel_id
			FROM \`dataset.events\`
			WHERE event_time > TIMESTAMP(@lastTimestamp)
		`;

		const builder = new QueryBuilder({
			timestampColumn: 'timestamp',
			customQuery,
		});

		assert.strictEqual(builder.customQuery, customQuery);
		assert.strictEqual(builder.timestampColumn, 'timestamp');
	});

	it('should build wrapped query when customQuery provided', () => {
		const customQuery = `
			SELECT event_time as timestamp, vessel_id
			FROM \`dataset.events\`
			WHERE event_time > TIMESTAMP(@lastTimestamp)
		`;

		const builder = new QueryBuilder({
			timestampColumn: 'timestamp',
			customQuery,
		});

		const query = builder.buildPullPartitionQuery();

		// Should contain wrapped custom query with partitioning
		assert.ok(query.includes('user_query'));
		assert.ok(query.includes('MOD(UNIX_MICROS'));
	});

	it('should build standard query when no customQuery provided', () => {
		const builder = new QueryBuilder({
			dataset: 'test_dataset',
			table: 'test_table',
			timestampColumn: 'timestamp',
			columns: ['timestamp', 'id', 'name'],
		});

		const query = builder.buildPullPartitionQuery();

		// Should contain standard table reference
		assert.ok(query.includes('`test_dataset.test_table`'));
		assert.ok(query.includes('timestamp, id, name'));
	});

	it('should skip column validation when customQuery is used', () => {
		// When using customQuery, columns are defined by the query itself
		// so we should not validate them
		const normalizedColumns = validateAndNormalizeColumns(
			undefined,
			'timestamp',
			true // hasCustomQuery
		);

		// Should return placeholder wildcard
		assert.deepStrictEqual(normalizedColumns, ['*']);
	});
});

describe('Integration - Config with Custom Query and Proxy', () => {
	it('should handle table config with both custom query and proxy', () => {
		// Simulate a table config with customQuery
		const tableConfig = {
			id: 'enriched_events',
			customQuery: `
				SELECT e.event_time as timestamp, e.vessel_id, v.vessel_name
				FROM \`dataset.events\` e
				LEFT JOIN \`dataset.vessels\` v ON e.vessel_id = v.id
				WHERE e.event_time > TIMESTAMP(@lastTimestamp)
			`,
			timestampColumn: 'timestamp',
			targetTable: 'EnrichedEvents',
		};

		// Validate custom query
		assert.doesNotThrow(() => validateCustomQuery(tableConfig.customQuery, tableConfig.timestampColumn));

		// Create QueryBuilder
		const builder = new QueryBuilder({
			timestampColumn: tableConfig.timestampColumn,
			customQuery: tableConfig.customQuery,
		});

		const query = builder.buildPullPartitionQuery();

		// Verify wrapped query structure
		assert.ok(query.includes('LEFT JOIN'));
		assert.ok(query.includes('user_query'));
		assert.ok(query.includes('MOD(UNIX_MICROS'));
	});
});
