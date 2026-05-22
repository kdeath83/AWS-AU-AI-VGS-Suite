/**
 * src/lambda/govern/prompt-evaluation/index.py
 * Lambda-based custom evaluation for Bedrock Advanced Prompt Optimization.
 * Evaluates structured output against ground truth answers.
 */

import json
import re
import boto3
import os
from typing import Dict, Any, List

def parse_jsonl(file_content: str) -> List[Dict[str, Any]]:
    """Parse JSONL file content into list of records."""
    records = []
    for line in file_content.strip().split('\n'):
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records

def evaluate_exact_match(predicted: str, ground_truth: str) -> float:
    """Exact match evaluation (1.0 if match, 0.0 otherwise)."""
    return 1.0 if predicted.strip() == ground_truth.strip() else 0.0

def evaluate_f1(predicted: str, ground_truth: str) -> float:
    """F1 score evaluation for token overlap."""
    pred_tokens = set(predicted.lower().split())
    gt_tokens = set(ground_truth.lower().split())
    
    if len(pred_tokens) == 0 and len(gt_tokens) == 0:
        return 1.0
    if len(pred_tokens) == 0 or len(gt_tokens) == 0:
        return 0.0
    
    intersection = pred_tokens & gt_tokens
    precision = len(intersection) / len(pred_tokens)
    recall = len(intersection) / len(gt_tokens)
    
    if precision + recall == 0:
        return 0.0
    return 2 * (precision * recall) / (precision + recall)

def evaluate_semantic_similarity(predicted: str, ground_truth: str) -> float:
    """Simple semantic similarity using normalized Levenshtein-like approach."""
    # For POC: use normalized character overlap as proxy for semantic similarity
    pred_chars = set(predicted.lower())
    gt_chars = set(ground_truth.lower())
    
    if len(pred_chars) == 0 and len(gt_chars) == 0:
        return 1.0
    
    intersection = pred_chars & gt_chars
    union = pred_chars | gt_chars
    
    return len(intersection) / len(union) if union else 0.0

def evaluate_structured_output(predicted: str, ground_truth: str, schema: Dict[str, Any]) -> Dict[str, float]:
    """Evaluate structured JSON output against ground truth."""
    try:
        pred_json = json.loads(predicted)
        gt_json = json.loads(ground_truth)
    except json.JSONDecodeError:
        return {"valid_json": 0.0, "schema_match": 0.0, "value_accuracy": 0.0}
    
    # Check JSON validity
    valid_json = 1.0
    
    # Check schema match (keys present)
    pred_keys = set(pred_json.keys())
    gt_keys = set(gt_json.keys())
    schema_match = len(pred_keys & gt_keys) / len(gt_keys) if gt_keys else 1.0
    
    # Check value accuracy for matching keys
    matching_values = 0
    total_values = 0
    for key in gt_keys:
        if key in pred_json:
            total_values += 1
            if isinstance(gt_json[key], (int, float, str, bool)):
                if str(pred_json[key]).lower() == str(gt_json[key]).lower():
                    matching_values += 1
            elif isinstance(gt_json[key], list):
                if set(str(x) for x in gt_json[key]) == set(str(x) for x in pred_json[key]):
                    matching_values += 1
            elif isinstance(gt_json[key], dict):
                if pred_json[key] == gt_json[key]:
                    matching_values += 1
    
    value_accuracy = matching_values / total_values if total_values > 0 else 0.0
    
    return {
        "valid_json": valid_json,
        "schema_match": schema_match,
        "value_accuracy": value_accuracy,
    }

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda handler for prompt optimization evaluation.
    
    Expected event format:
    {
        "modelOutput": "<model generated output>",
        "groundTruth": "<expected ground truth>",
        "evaluationConfig": {
            "metrics": ["exact_match", "f1", "semantic_similarity", "structured_output"],
            "schema": {}  // Optional JSON schema for structured output validation
        }
    }
    """
    print(json.dumps({"level": "INFO", "message": "Prompt evaluation invoked", "event": event}))
    
    try:
        model_output = event.get("modelOutput", "")
        ground_truth = event.get("groundTruth", "")
        eval_config = event.get("evaluationConfig", {})
        metrics = eval_config.get("metrics", ["exact_match", "f1", "semantic_similarity"])
        schema = eval_config.get("schema", {})
        
        results = {}
        overall_score = 0.0
        
        for metric in metrics:
            if metric == "exact_match":
                score = evaluate_exact_match(model_output, ground_truth)
                results["exact_match"] = score
                overall_score += score
                
            elif metric == "f1":
                score = evaluate_f1(model_output, ground_truth)
                results["f1"] = score
                overall_score += score
                
            elif metric == "semantic_similarity":
                score = evaluate_semantic_similarity(model_output, ground_truth)
                results["semantic_similarity"] = score
                overall_score += score
                
            elif metric == "structured_output":
                structured_results = evaluate_structured_output(model_output, ground_truth, schema)
                results["structured_output"] = structured_results
                overall_score += sum(structured_results.values()) / len(structured_results) if structured_results else 0
        
        # Normalize overall score
        if metrics:
            overall_score /= len(metrics)
        
        response = {
            "statusCode": 200,
            "overallScore": round(overall_score, 4),
            "metrics": results,
            "pass": overall_score >= 0.7,  # Pass threshold
            "requestId": context.aws_request_id if hasattr(context, "aws_request_id") else "unknown"
        }
        
        print(json.dumps({"level": "INFO", "message": "Prompt evaluation complete", "response": response}))
        return response
        
    except Exception as e:
        error_response = {
            "statusCode": 500,
            "error": str(e),
            "requestId": context.aws_request_id if hasattr(context, "aws_request_id") else "unknown"
        }
        print(json.dumps({"level": "ERROR", "message": "Prompt evaluation failed", "error": str(e)}))
        return error_response
