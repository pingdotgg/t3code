import json
from pathlib import Path
import tempfile
import unittest

from experiment import choose, joined, metrics, packets, digest, PROMPTS, wilson_interval, verify_receipt


class ExperimentTest(unittest.TestCase):
    def test_abstention_and_ineligible_switches_remain_in_path_recall(self):
        rows = [
            dict(id='a', label='NEW_TASK', score=.9, eligible=True),
            dict(id='b', label='NEW_TASK', score=.9, eligible=False),
            dict(id='c', label='NEW_TASK', score=None, eligible=True),
            dict(id='d', label='NO_TASK', score=.95, eligible=True),
            dict(id='e', label='CONTINUE', score=.1, eligible=True),
            dict(id='f', label='UNCERTAIN', score=.99, eligible=True),
        ]
        classifier = metrics(rows, .8, False)
        path = metrics(rows, .8, True)
        self.assertEqual((classifier['tp'], classifier['fn'], classifier['abstained']), (2, 0, 1))
        self.assertEqual((path['tp'], path['fn'], path['abstained']), (1, 2, 2))
        self.assertEqual(path['recall'], 1 / 3)
        self.assertEqual(path['fp'], 1)
        self.assertEqual(path['classes']['UNCERTAIN'], 1)
        eligible = metrics([r for r in rows if r['eligible']], .8, False)
        self.assertEqual(eligible['false_suggestion_rate'], .5)
        self.assertEqual(eligible['predicted_by_class']['UNCERTAIN'], 1)
        self.assertEqual(path['ineligible'], 1)
        self.assertEqual(path['failed'], 1)
        self.assertGreater(wilson_interval(0, 100)[1], .03)
        self.assertLess(wilson_interval(3, 3)[0], .5)
        self.assertIsNone(wilson_interval(0, 0))

    def test_no_admissible_useful_cutoff_disables_instead_of_relaxing_budget(self):
        rows = [dict(label='NEW_TASK', score=.8, eligible=True),
                dict(label='NO_TASK', score=.9, eligible=True)]
        self.assertIsNone(choose(rows, .01))
        self.assertIsNone(choose(rows, 1))
        enough = ([dict(label='NEW_TASK', score=.8, eligible=True) for _ in range(5)]
                  + [dict(label='CONTINUE', score=.1, eligible=True) for _ in range(100)])
        self.assertEqual(choose(enough, .01), .8)
        enough[-1]['score'] = None
        self.assertIsNone(choose(enough, .01))

    def test_session_leakage_and_receipt_drift_are_rejected(self):
        state = dict(prior_thread=[dict(user='Run tests', assistant_final='Passed')], new_message='Thanks')
        data = [dict(id='a', session='same', split='calibration', state=state,
                     eligibility=dict(eligible=True, reasons=[])),
                dict(id='b', session='same', split='evaluation', state=state,
                     eligibility=dict(eligible=True, reasons=[]))]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packets.json'
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'Session appears'):
                packets(path)
        data[1]['session'] = 'different-session-same-ancestry'
        for row in data:
            row['session_group'] = 'shared-ancestry'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packets.json'
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'Session group appears'):
                packets(path)
        data[1]['session_group'] = 'unseen-group'
        data[1]['previously_exposed_session'] = True
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'packets.json'
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'Previously exposed'):
                packets(path)
        receipt = dict(id='a', session='same', state_sha256=digest(state),
                       prompt_sha256=digest(PROMPTS['baseline']), score=.1)
        rows = joined(data[:1], {'a': 'NO_TASK'}, {('a', 'baseline'): receipt}, 'baseline', 'calibration')
        self.assertEqual(len(rows), 1)
        receipt['state_sha256'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'packet state'):
            joined(data[:1], {'a': 'NO_TASK'}, {('a', 'baseline'): receipt}, 'baseline', 'calibration')
        with self.assertRaisesRegex(ValueError, 'Every packet'):
            joined(data[:1], {'a': 'NO_TASK'}, {}, 'baseline', 'calibration')

    def test_frozen_receipt_rejects_changed_labels_sources_and_split(self):
        artifact = dict(packets_sha256='packet-digest', source_sha256={'detector.py': 'source-digest'})
        truth = {'a': 'CONTINUE'}
        receipt = dict(artifact, split='evaluation', prompts={'baseline': PROMPTS['baseline']},
                       labels_sha256=digest(truth))
        verify_receipt(receipt, artifact, 'evaluation', truth)
        with self.assertRaisesRegex(ValueError, 'Frozen labels'):
            verify_receipt(receipt, artifact, 'evaluation', {'a': 'NEW_TASK'})
        with self.assertRaisesRegex(ValueError, 'source_sha256'):
            verify_receipt(receipt, dict(artifact, source_sha256={'detector.py': 'new'}), 'evaluation', truth)
        with self.assertRaisesRegex(ValueError, 'split mismatch'):
            verify_receipt(receipt, artifact, 'calibration', truth)
        receipt['prompts'] = {'baseline': {'instructions': 'changed'}}
        with self.assertRaisesRegex(ValueError, 'prompt mismatch'):
            verify_receipt(receipt, artifact, 'evaluation', truth)


if __name__ == '__main__':
    unittest.main()
