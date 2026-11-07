// The database's engine worker: smaltdb with SQL (smaltql) and dataframes (smaltdf) registered. smaltdf's views are
// read here, so it registers too.
import { defineWorker } from 'smaltdb/worker-runtime';
import { sqlLanguage } from 'smaltql';
import { dfLanguage } from '@smaltdb/df';

defineWorker({ languages: [sqlLanguage, dfLanguage] });
