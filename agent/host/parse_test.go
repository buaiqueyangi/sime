package main

import "testing"

func TestParseBothFormats(t *testing.T) {
	cases := []struct{ line string; wantOutcome string; wantIP string }{
		{"2026-10-24T18:24:03.867745+08:00 debian sshd[114140]: Failed password for root from 192.168.2.1 port 5227 ssh2", "failure", "192.168.2.1"},
		{"Oct 24 18:24:03 debian sshd[99]: Failed password for invalid user admin from 203.0.113.9 port 41022 ssh2", "failure", "203.0.113.9"},
		{"2026-10-24T18:24:03.000000+08:00 debian sshd[1]: Accepted password for root from 192.168.2.1 port 5227 ssh2", "success", "192.168.2.1"},
	}
	for _, c := range cases {
		ev := parseAuthLine(c.line, "srv-debian")
		if ev == nil { t.Fatalf("未解析: %s", c.line) }
		e := ev["event"].(map[string]interface{})
		s := ev["src"].(map[string]interface{})
		if e["outcome"] != c.wantOutcome || s["ip"] != c.wantIP {
			t.Errorf("outcome=%v ip=%v, 期望 %v/%v (%s)", e["outcome"], s["ip"], c.wantOutcome, c.wantIP, c.line)
		}
	}
}
