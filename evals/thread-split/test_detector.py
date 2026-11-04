import unittest
from types import SimpleNamespace

from detector import score_response, summarize


class DetectorTest(unittest.TestCase):
    def test_truncation_abstains_even_when_score_would_suggest_split(self):
        response = SimpleNamespace(truncated=True, answers={'q': SimpleNamespace(noul=1.0)})
        self.assertIsNone(score_response(response))
        for invalid in (float('nan'), float('inf'), -0.1, 1.1):
            response = SimpleNamespace(truncated=False, answers={'q': SimpleNamespace(noul=invalid)})
            with self.assertRaises(ValueError):
                score_response(response)

    def test_confusion_counts_include_boundary_and_report_abstentions(self):
        rows = [
            dict(id='switch', label='INDEPENDENT', score=0.94),
            dict(id='followup', label='DEPENDS', score=0.95),
            dict(id='miss', label='INDEPENDENT', score=0.2),
            dict(id='keep', label='DEPENDS', score=0.2),
            dict(id='error', label='INDEPENDENT', score=None),
        ]
        self.assertEqual(summarize(rows, 0.94), dict(tp=1, fp=1, tn=1, fn=1, abstained=1))
        with self.assertRaises(ValueError):
            summarize(rows + rows[:1], 0.94)
        with self.assertRaises(ValueError):
            summarize([dict(id='bad', label='UNKNOWN', score=0.8)], 0.94)


if __name__ == '__main__':
    unittest.main()
