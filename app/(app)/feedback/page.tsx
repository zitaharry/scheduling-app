import FeedbackForm from "@/components/feedback/feedback-form";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import React from "react";

const Feedback = async () => {
  const { userId } = await auth();
  if (!userId) {
    redirect("/");
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-4">
      <FeedbackForm />
    </div>
  );
};

export default Feedback;
