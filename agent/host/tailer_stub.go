//go:build !linux && !windows

package main

// 非 linux/windows 平台（开发机 darwin 等）：无事件流，仅心跳/基线。
func (a *Agent) tailAuthLog() {}
