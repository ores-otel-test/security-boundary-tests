import unittest

from deep_tests.security_model import BoundaryViolation, normalize_relative_path, validate_outbound_url


class SecurityEncodingFollowupTests(unittest.TestCase):
    def test_encoded_parent_segment_matrix_fails_closed(self):
        for value in ("collector/%2e%2e/secret", "%2E%2e/%2e%2E/secret", "collector/%252e%252e/secret", "%2e%2e%2fsecret"):
            with self.assertRaises(BoundaryViolation):
                normalize_relative_path(value)

    def test_exporter_authority_confusion_fails_closed(self):
        allowed = {"otel.example.test"}
        for value in ("https://otel.example.test.attacker.invalid/v1", "https://otel.example.test%40attacker.invalid/v1", "https://attacker.invalid/?next=https://otel.example.test", "//attacker.invalid/otel.example.test"):
            with self.assertRaises(BoundaryViolation):
                validate_outbound_url(value, allowed)


if __name__ == "__main__":
    unittest.main()
