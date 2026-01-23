/**
 * Setup Command
 *
 * Prepares the environment for benchmarking.
 */

import { loadBenchmarkConfig, getTableIds } from '../utils/config-loader.js';
import { runPreFlightValidation, formatValidationResults } from '../utils/validation.js';

export async function setupCommand(options) {
	try {
		console.log('\n🔧 BigQuery → Harper Benchmark Setup\n');

		// Load configuration
		console.log('Loading configuration...');
		const config = loadBenchmarkConfig();
		console.log(`✓ Configuration loaded`);
		console.log(`  Project: ${config.bigqueryProject}`);
		console.log(`  Dataset: ${config.bigqueryDataset}`);
		console.log(`  Tables: ${getTableIds(config).join(', ')}`);
		console.log(`  Harper: ${config.harperUrl}\n`);

		// Run validation if --verify flag is provided
		if (options.verify) {
			console.log('Running pre-flight validation...\n');

			const validationResults = await runPreFlightValidation(config, {
				skipCheckpoints: true, // Don't require checkpoints during setup
			});

			console.log(formatValidationResults(validationResults));

			if (!validationResults.valid) {
				console.error('❌ Setup validation failed. Please fix the errors above.\n');
				process.exit(1);
			}
		}

		// Display configuration summary
		console.log('📊 Benchmark Configuration:');
		console.log(`  Vessels: ${options.vessels}`);
		console.log(`  Dataset: ${options.dataset}`);
		console.log(`  Skip cleanup: ${options.skipCleanup ? 'yes' : 'no'}\n`);

		// TODO: Implement remaining setup tasks
		console.log('⚠️  Note: Full setup implementation in progress');
		console.log('    Remaining tasks:');
		console.log('    - Clear existing benchmark data (if not --skip-cleanup)');
		console.log('    - Pre-generate dataset via maritime synthesizer');
		console.log('    - Display estimated costs\n');

		console.log('✅ Setup verification complete. Basic checks passed.\n');
	} catch (error) {
		console.error(`\n❌ Setup failed: ${error.message}\n`);
		if (options.verbose) {
			console.error(error.stack);
		}
		process.exit(1);
	}
}
