import unittest
from models import TrackAnalysis
from planner import plan_transition, camelot_distance


def analysis(track_id, bpm, camelot='8A', energy=0.5, vocal=0.1, bass=0.3, duration=180, conf=0.8):
    return TrackAnalysis(track_id=track_id, duration=duration, bpm=bpm, bpm_confidence=conf,
        beat_grid=[i * 60 / bpm for i in range(int(duration * bpm / 60))],
        downbeats=[i * 60 / bpm for i in range(0, int(duration * bpm / 60), 4)],
        key='A min', camelot=camelot, key_confidence=conf,
        energy_curve=[energy] * 32, structure=[], vocal_activity=[vocal] * 32,
        bass_activity=[bass] * 32, integrated_lufs=-12, true_peak_db=-1, analysis_confidence=conf)


class PlannerTests(unittest.TestCase):
    def test_camelot_distance(self):
        self.assertEqual(camelot_distance('8A', '8A'), 0)
        self.assertEqual(camelot_distance('8A', '9A'), 1)
        self.assertEqual(camelot_distance('8A', '8B'), 1)
        self.assertEqual(camelot_distance('1A', '12A'), 1)
        self.assertEqual(camelot_distance('?', '8A'), 12)

    def test_late_plan(self):
        p = plan_transition(analysis('a', 120), analysis('b', 124))
        self.assertGreaterEqual(p.outgoing_start, 180 * 0.7)
        self.assertLessEqual(p.outgoing_start + p.duration, 180)
        self.assertIn(p.strategy, ('beatmatched', 'harmonic-layer', 'bass-swap', 'energy-punch'))
        self.assertGreater(p.confidence, 0.3)

    def test_bpm_gap_is_smart_cut(self):
        p = plan_transition(analysis('a', 120), analysis('b', 150))
        self.assertEqual(p.strategy, 'smart-cut')
        self.assertLessEqual(p.duration, 8.0)

    def test_key_clash_is_smooth_blend(self):
        p = plan_transition(analysis('a', 120, '1A'), analysis('b', 120, '8B'))
        self.assertEqual(p.strategy, 'smooth-blend')

    def test_vocal_collision(self):
        p = plan_transition(analysis('a', 120, vocal=0.8), analysis('b', 120, vocal=0.8))
        self.assertEqual(p.strategy, 'vocal-aware')
        self.assertIsNotNone(p.vocal_duck)

    def test_bass_collision(self):
        p = plan_transition(analysis('a', 120, bass=0.8), analysis('b', 120, bass=0.8))
        self.assertEqual(p.strategy, 'bass-swap')
        self.assertEqual(len(p.eq), 4)

    def test_low_confidence_no_transition(self):
        p = plan_transition(analysis('a', 120, conf=0.1), analysis('b', 120, conf=0.1))
        self.assertIn(p.strategy, ('no-transition', 'smooth-blend'))
        self.assertIsNotNone(p.fallback)


if __name__ == '__main__':
    unittest.main()
