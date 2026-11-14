module example.com/facts/core

go 1.22

require (
	example.com/lib/one v1.0.0
	example.com/lib/two v1.2.0 // indirect
)

require example.com/lib/three v0.1.0
