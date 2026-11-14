package main

import "net/http"

func main() {
	http.HandleFunc("GET /reports/{id}", report)
	http.HandleFunc("/health", health)
	_ = http.ListenAndServe(":8080", nil)
}

func report(w http.ResponseWriter, r *http.Request) {}
func health(w http.ResponseWriter, r *http.Request) {}
